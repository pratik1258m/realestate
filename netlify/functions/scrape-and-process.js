const RSSParser = require('rss-parser');

let activeKeyIndex = 0;
const failoverLogs = [];

// Helper: Extract original image from RSS item
function extractImage(item) {
  if (!item) return null;
  if (item.enclosure && item.enclosure.url) {
    return item.enclosure.url;
  }
  if (item.image && typeof item.image === 'string') return item.image;
  if (item.image && item.image.url) return item.image.url;
  if (item.thumbnail && typeof item.thumbnail === 'string') return item.thumbnail;
  if (item.thumbnail && item.thumbnail.url) return item.thumbnail.url;
  
  const html = (item.content || '') + (item.description || '') + (item.contentSnippet || '');
  if (html) {
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().toLowerCase().trim();
  } catch (e) {
    return url.toLowerCase().trim();
  }
}

// Helper: Secure Groq call with automatic failover & rate-limit retries
async function callGroqWithFailover(messages, keys, retryCount = 0, rateLimitRetries = 0) {
  if (!keys || keys.length === 0) {
    throw new Error("No Groq API keys configured. Please enter them in the Admin Panel or set env variables.");
  }
  if (retryCount >= keys.length) {
    throw new Error(`Groq API calls failed on all ${keys.length} available keys.`);
  }

  const currentIdx = activeKeyIndex % keys.length;
  const apiKey = keys[currentIdx];
  const redactedKey = apiKey.substring(0, 8) + '...' + apiKey.substring(apiKey.length - 4);
  console.log(`[Groq API] Attempting call with Key #${currentIdx + 1} (${redactedKey})`);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: messages,
        temperature: 0.1,
        response_format: { type: 'json_object' }
      })
    });

    if (response.status === 429) {
      const errorText = await response.text();
      let waitMs = 6000; // default wait
      try {
        const parsed = JSON.parse(errorText);
        const msg = parsed.error?.message || '';
        const secMatch = msg.match(/try again in (\d+\.?\d*)s/i);
        const msMatch = msg.match(/try again in (\d+)ms/i);
        if (secMatch) {
          waitMs = parseFloat(secMatch[1]) * 1000 + 750; // safety padding
        } else if (msMatch) {
          waitMs = parseInt(msMatch[1], 10) + 300;
        }
      } catch (pe) {}

      // Rotate key immediately if there are other keys available to avoid timeout
      if (keys.length > 1 && retryCount < keys.length - 1) {
        console.warn(`[Groq API Rate Limit] Key #${currentIdx + 1} hit 429. Rotating key immediately to avoid serverless timeout...`);
        failoverLogs.push({
          timestamp: new Date().toISOString(),
          failedKeyIndex: currentIdx,
          error: `HTTP 429 Rate Limit. Wait required: ${Math.round(waitMs / 1000)}s`,
          nextKeyIndex: (currentIdx + 1) % keys.length
        });
        activeKeyIndex = (currentIdx + 1) % keys.length;
        return callGroqWithFailover(messages, keys, retryCount + 1, 0);
      }

      // If only 1 key or all keys rotated, wait only if the wait time is safe (< 4s)
      if (waitMs < 4000) {
        console.warn(`[Groq API Rate Limit] Key #${currentIdx + 1} hit 429. Waiting ${Math.round(waitMs / 1000)}s before retry #${rateLimitRetries + 1}...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return callGroqWithFailover(messages, keys, retryCount, rateLimitRetries + 1);
      } else {
        throw new Error(`Groq rate limit try again time (${Math.round(waitMs / 1000)}s) exceeds safe serverless limits.`);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return { data, keyUsed: redactedKey, keyIndex: currentIdx };
  } catch (err) {
    const errorMsg = err.message || err;
    
    // Catch-block rate limit handling
    if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('rate limit')) {
      if (keys.length > 1 && retryCount < keys.length - 1) {
        console.warn(`[Groq API Rate Limit Catch] Key #${currentIdx + 1} hit rate limit. Rotating key immediately...`);
        failoverLogs.push({
          timestamp: new Date().toISOString(),
          failedKeyIndex: currentIdx,
          error: `Caught rate limit: ${errorMsg}`,
          nextKeyIndex: (currentIdx + 1) % keys.length
        });
        activeKeyIndex = (currentIdx + 1) % keys.length;
        return callGroqWithFailover(messages, keys, retryCount + 1, 0);
      }
      
      const waitMs = Math.pow(2, rateLimitRetries) * 3000 + 3000;
      if (waitMs < 4000 && rateLimitRetries < 5) {
        console.warn(`[Groq API Rate Limit Catch] Waiting ${Math.round(waitMs / 1000)}s before retry #${rateLimitRetries + 1}...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return callGroqWithFailover(messages, keys, retryCount, rateLimitRetries + 1);
      }
    }

    console.error(`[Groq API Error] Key #${currentIdx + 1} failed: ${errorMsg}`);
    
    // Log the failover event
    failoverLogs.push({
      timestamp: new Date().toISOString(),
      failedKeyIndex: currentIdx,
      error: errorMsg,
      nextKeyIndex: (currentIdx + 1) % keys.length
    });

    // Rotate key
    activeKeyIndex = (currentIdx + 1) % keys.length;
    
    // Retry recursively (resets rateLimitRetries for the new key)
    return callGroqWithFailover(messages, keys, retryCount + 1, 0);
  }
}

// Tokenize title for similarity analysis
function getTokens(text) {
  if (!text) return new Set();
  const stopWords = new Set(['in', 'the', 'a', 'of', 'and', 'to', 'for', 'on', 'is', 'at', 'by', 'an', 'with', 'from', 'as', 'its', 'for', 'new']);
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  );
}

// Calculate Jaccard Similarity between two sets
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// Heuristic keyword pre-scoring — balanced weights across all 8 topic categories
function scoreRelevance(title, description) {
  const text = `${title} ${description || ''}`.toLowerCase();
  
  // BALANCED keyword weights — no single category dominates
  const keywords = {
    // RERA & Regulatory (capped at moderate weight)
    'rera': 5,
    'maharera': 5,
    'karnataka rera': 5,
    'up rera': 5,
    'rera penalty': 6,
    'rera order': 6,
    'show-cause': 5,
    // Project Launch
    'project launch': 7,
    'new launch': 7,
    'launched': 5,
    'housing project': 5,
    'luxury tower': 6,
    'residential project': 5,
    // Land Acquisition & Redevelopment
    'land acquisition': 7,
    'redevelopment': 7,
    'slum redevelopment': 7,
    'cluster redevelopment': 7,
    'demolition': 6,
    // Funding & Investment
    'funding': 7,
    'investment': 6,
    'private equity': 7,
    'reit': 7,
    'ipo': 6,
    'qip': 7,
    'fdi': 6,
    // Government Policy
    'stamp duty': 7,
    'ready reckoner': 7,
    'circle rate': 7,
    'property tax': 6,
    'affordable housing': 6,
    'pmay': 6,
    'smart city': 5,
    'housing policy': 6,
    // Infrastructure
    'metro rail': 7,
    'metro corridor': 7,
    'highway project': 6,
    'airport city': 7,
    'infrastructure': 5,
    'bullet train': 6,
    // Litigation & NCLT
    'nclt': 7,
    'insolvency': 7,
    'court orders': 6,
    'litigation': 6,
    'homebuyer litigation': 7,
    'builder fraud': 7,
    'flat buyer case': 6,
    'possession delay': 6,
    // General RE relevance
    'commercial space': 5,
    'office space': 5,
    'data centre': 5,
    'warehousing': 5,
    'builder': 3,
    'developer': 3,
    'flat buyers': 4,
    'homebuyers': 4
  };

  let score = 0;
  for (const [key, weight] of Object.entries(keywords)) {
    const regex = new RegExp(`\\b${key.replace(/-/g, '[- ]')}\\b`, 'gi');
    const matches = text.match(regex);
    if (matches) {
      score += weight * matches.length;
    }
  }
  
  // Bonus score if it contains major developer names
  const builders = ['lodha', 'dlf', 'godrej properties', 'tata housing', 'prestige group', 'sobha', 'oberoi realty', 'brigade', 'omkar', 'hiranandani', 'kolte-patil', 'l&t realty', 'shapoorji'];
  builders.forEach(b => {
    if (text.includes(b)) score += 5;
  });

  return score;
}

// Map article title to a topic bucket for diversity sampling
// ORDER MATTERS: specific positive categories first, dispute categories last
function detectTopicBucket(title) {
  const text = title.toLowerCase();
  // Check specific positive categories FIRST so they are not mis-classified as RERA/Litigation
  if (/\blaunch\b|launches|launched|new project|residential tower|housing project|new phase|new tower|unveils|inaugurate/i.test(text)) return 'Project Launch';
  if (/land acquisition|redevelopment|slum redevelopment|cluster redevelopment|\bsra\b|demolish/i.test(text)) return 'Redevelopment';
  if (/\bfunding\b|\binvestment\b|private equity|\breit\b|\bipo\b|\bqip\b|raises|crore fund|\bfdi\b|venture capital|series [a-c]/i.test(text)) return 'Funding';
  if (/stamp duty|circle rate|property tax|ready reckoner|\bpmay\b|affordable housing|housing policy|housing ministry|mohua/i.test(text)) return 'Government Policy';
  if (/\bmetro\b|highway project|airport city|\binfrastructure\b|bullet train|elevated road|expressway|flyover/i.test(text)) return 'Infrastructure';
  // Dispute categories checked LAST — only classify here if no positive category matched
  if (/\bnclt\b|insolvency|\blitigation\b|builder fraud|possession delay|flat buyer.*case|cheating|arrested/i.test(text)) return 'Litigation';
  if (/\brera\b|maharera|show.cause|show cause|notice.*developer|notice.*builder/i.test(text)) return 'RERA';
  return 'General';
}

async function runPipeline(groqKeys) {
  if (!groqKeys || groqKeys.length === 0) {
    throw new Error("No Groq API keys configured on Netlify. Please set GROQ_API_KEY_1 in your Netlify Environment Variables and trigger a new deploy.");
  }
  const parser = new RSSParser();
    
    // ============ RSS FEEDS — PRD TARGETS ALL SOURCES ============
    // Goal: 500+ raw articles daily. Each Google News query returns up to 100 items.
    // Direct RE portal feeds return 10-50 items each. Failed feeds are silently skipped.
    const feeds = [

      // ── GOOGLE NEWS RSS: ENGLISH — NATIONAL ──────────────────────────────────
      {
        name: 'Google News - EN: Real Estate General',
        url: 'https://news.google.com/rss/search?q=site:realty.economictimes.indiatimes.com+OR+site:moneycontrol.com/news/business/real-estate+OR+site:housing.com/news+OR+site:constructionweekonline.in+OR+%22real+estate+India%22+OR+%22RERA+India%22+OR+%22property+market+India%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Builder & Developer News',
        url: 'https://news.google.com/rss/search?q=%28Lodha+OR+DLF+OR+%22Godrej+Properties%22+OR+Sobha+OR+%22Prestige+Group%22+OR+Brigade+OR+%22Oberoi+Realty%22+OR+%22L%26T+Realty%22+OR+Hiranandani+OR+%22Kolte-Patil%22%29+%22real+estate%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: RERA & Regulatory',
        url: 'https://news.google.com/rss/search?q=RERA+%28builder+OR+developer+OR+homebuyer+OR+penalty+OR+registration+OR+complaint+OR+order%29+India&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: RE Funding & Investment',
        url: 'https://news.google.com/rss/search?q=%22real+estate%22+%28funding+OR+investment+OR+IPO+OR+REIT+OR+%22private+equity%22+OR+%22FDI%22+OR+%22QIP%22%29+India&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Government Policy & Housing',
        url: 'https://news.google.com/rss/search?q=%22affordable+housing%22+OR+%22Smart+City%22+OR+PMAY+OR+%22housing+policy%22+OR+%22stamp+duty%22+OR+%22ready+reckoner%22+OR+%22circle+rate%22+India&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Infrastructure & Metro',
        url: 'https://news.google.com/rss/search?q=%22metro+rail%22+OR+%22highway+project%22+OR+%22airport+city%22+OR+%22bullet+train%22+OR+%22elevated+road%22+%22real+estate%22+India&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Land Acquisition & Redevelopment',
        url: 'https://news.google.com/rss/search?q=%22land+acquisition%22+OR+%22redevelopment+project%22+OR+%22slum+redevelopment%22+OR+%22cluster+redevelopment%22+OR+%22SRA+project%22+India&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Luxury & Commercial RE',
        url: 'https://news.google.com/rss/search?q=%22luxury+housing%22+OR+%22ultra-luxury%22+OR+%22commercial+real+estate%22+OR+%22office+space%22+OR+%22data+centre%22+OR+%22warehousing%22+India&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Litigation & NCLT',
        url: 'https://news.google.com/rss/search?q=%22NCLT%22+OR+%22insolvency%22+OR+%22homebuyer+litigation%22+OR+%22builder+fraud%22+OR+%22flat+buyer+case%22+%22real+estate%22+India&hl=en-IN&gl=IN&ceid=IN:en'
      },

      // ── GOOGLE NEWS RSS: ENGLISH — CITY / REGION SPECIFIC ────────────────────
      {
        name: 'Google News - EN: Mumbai & MMR',
        url: 'https://news.google.com/rss/search?q=%22Mumbai+real+estate%22+OR+%22MMR+property%22+OR+%22MahaRERA%22+OR+%22Thane+real+estate%22+OR+%22Navi+Mumbai+property%22+OR+%22Vasai+Virar%22+OR+%22Kalyan+Dombivli%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: NCR & Delhi',
        url: 'https://news.google.com/rss/search?q=%22Delhi+real+estate%22+OR+%22Gurugram+property%22+OR+%22Noida+real+estate%22+OR+%22Greater+Noida%22+OR+%22Gurgaon+real+estate%22+OR+%22UP+RERA%22+OR+%22Faridabad%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Pune & PCMC',
        url: 'https://news.google.com/rss/search?q=%22Pune+real+estate%22+OR+%22Pune+property%22+OR+%22Pune+RERA%22+OR+%22PCMC+property%22+OR+%22Hinjewadi%22+OR+%22Wakad+property%22+OR+%22Kharadi%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Bengaluru',
        url: 'https://news.google.com/rss/search?q=%22Bengaluru+real+estate%22+OR+%22Bangalore+property%22+OR+%22Karnataka+RERA%22+OR+%22Whitefield%22+OR+%22Electronic+City%22+OR+%22Sarjapur%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Hyderabad & Telangana',
        url: 'https://news.google.com/rss/search?q=%22Hyderabad+real+estate%22+OR+%22Hyderabad+property%22+OR+%22Telangana+RERA%22+OR+%22HMDA%22+OR+%22Gachibowli%22+OR+%22Financial+District%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Chennai & Tamil Nadu',
        url: 'https://news.google.com/rss/search?q=%22Chennai+real+estate%22+OR+%22Tamil+Nadu+RERA%22+OR+%22TNRERA%22+OR+%22Chennai+property%22+OR+%22OMR+corridor%22&hl=en-IN&gl=IN&ceid=IN:en'
      },

      // ── GOOGLE NEWS RSS: HINDI ────────────────────────────────────────────────
      {
        name: 'Google News - HI: Real Estate General',
        url: 'https://news.google.com/rss/search?q=%22%E0%A4%B0%E0%A4%B6%E0%A4%AF%E0%A4%B2+%E0%A4%8F%E0%A4%B8%E0%A5%8D%E0%A4%9F%E0%A5%87%E0%A4%9F%22+OR+%22%E0%A4%AE%E0%A4%B9%E0%A4%BE%E0%A4%B0%E0%A5%87%E0%A4%B0%E0%A4%BE%22+OR+%22%E0%A4%B8%E0%A4%82%E0%A4%AA%E0%A4%A4%E0%A5%8D%E0%A4%A4%E0%A4%BF+%E0%A4%AC%E0%A4%BE%E0%A4%9C%E0%A4%BE%E0%A4%B0%22&hl=hi&gl=IN&ceid=IN:hi'
      },
      {
        name: 'Google News - HI: RERA & Homebuyer',
        url: 'https://news.google.com/rss/search?q=RERA+%22%E0%A4%AE%E0%A4%95%E0%A4%BE%E0%A4%A8%22+OR+%22%E0%A4%86%E0%A4%B5%E0%A4%BE%E0%A4%B8%22+OR+%22%E0%A4%AB%E0%A5%8D%E0%A4%B2%E0%A5%88%E0%A4%9F%22+OR+%22%E0%A4%AC%E0%A4%BF%E0%A4%B2%E0%A5%8D%E0%A4%A1%E0%A4%B0%22&hl=hi&gl=IN&ceid=IN:hi'
      },
      {
        name: 'Google News - HI: Property News',
        url: 'https://news.google.com/rss/search?q=%22%E0%A4%AA%E0%A5%8D%E0%A4%B0%E0%A5%89%E0%A4%AA%E0%A4%B0%E0%A5%8D%E0%A4%9F%E0%A5%80%22+OR+%22%E0%A4%9C%E0%A4%AE%E0%A5%80%E0%A4%A8%22+OR+%22%E0%A4%85%E0%A4%A7%E0%A4%BF%E0%A4%97%E0%A5%8D%E0%A4%B0%E0%A4%B9%E0%A4%A3%22+OR+%22%E0%A4%AE%E0%A4%95%E0%A4%BE%E0%A4%A8%22+%22%E0%A4%AD%E0%A4%BE%E0%A4%B0%E0%A4%A4%22&hl=hi&gl=IN&ceid=IN:hi'
      },

      // ── DIRECT RSS FEEDS — REAL ESTATE PUBLICATIONS ──────────────────────────
      {
        name: 'Economic Times Realty',
        url: 'https://realty.economictimes.indiatimes.com/rss/topstories'
      },
      {
        name: 'Moneycontrol Real Estate',
        url: 'https://www.moneycontrol.com/rss/realestate.xml'
      },
      {
        name: 'Housing.com News',
        url: 'https://housing.com/news/feed/'
      },
      {
        name: 'Construction Week India',
        url: 'https://www.constructionweekonline.in/feed'
      },
      {
        name: 'MagicBricks Research Blog',
        url: 'https://www.magicbricks.com/blog/feed'
      },
      {
        name: 'PropTiger News',
        url: 'https://www.proptiger.com/blog/feed/'
      },
      {
        name: 'Business Standard Real Estate',
        url: 'https://www.business-standard.com/rss/real-estate-06.rss'
      },
      {
        name: 'Financial Express Real Estate',
        url: 'https://www.financialexpress.com/real-estate/feed/'
      },
      {
        name: 'The Hindu BusinessLine Property',
        url: 'https://www.thehindubusinessline.com/real-estate/feeder/default.rss'
      },
      {
        name: 'LiveMint Money & Property',
        url: 'https://www.livemint.com/rss/money'
      },
      {
        name: 'NDTV Profit Real Estate',
        url: 'https://feeds.feedburner.com/ndtvprofit-latest'
      },
      {
        name: 'India Today Money',
        url: 'https://www.indiatoday.in/rss/1206517'
      },

      // ── ADDITIONAL SOURCES — PRD COMPLIANCE (500+ target) ────────────────────
      {
        name: 'Google News - EN: Ahmedabad & Gujarat RE',
        url: 'https://news.google.com/rss/search?q=%22Ahmedabad+real+estate%22+OR+%22Gujarat+RERA%22+OR+%22GRERA%22+OR+%22Surat+property%22+OR+%22Vadodara+real+estate%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Kolkata & West Bengal RE',
        url: 'https://news.google.com/rss/search?q=%22Kolkata+real+estate%22+OR+%22West+Bengal+RERA%22+OR+%22HIRA+Bengal%22+OR+%22Newtown+property%22+OR+%22Rajarhat+real+estate%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - EN: Government Housing Policy',
        url: 'https://news.google.com/rss/search?q=site:mohua.gov.in+OR+%22Ministry+of+Housing%22+OR+%22MoHUA%22+OR+%22PM+Awas+Yojana%22+OR+%22housing+ministry+India%22&hl=en-IN&gl=IN&ceid=IN:en'
      },
      {
        name: 'Google News - HI: Builder & Developer Hindi',
        url: 'https://news.google.com/rss/search?q=%22%E0%A4%AC%E0%A4%BF%E0%A4%B2%E0%A5%8D%E0%A4%A1%E0%A4%B0%22+OR+%22%E0%A4%A1%E0%A5%87%E0%A4%B5%E0%A4%B2%E0%A4%AA%E0%A4%B0%22+OR+%22%E0%A4%AA%E0%A5%8D%E0%A4%B0%E0%A4%BE%E0%A4%AA%E0%A4%B0%E0%A5%8D%E0%A4%9F%E0%A5%80%22+%22%E0%A4%AD%E0%A4%BE%E0%A4%B0%E0%A4%A4%22&hl=hi&gl=IN&ceid=IN:hi'
      },
      {
        name: '99acres Blog',
        url: 'https://www.99acres.com/articles/feed'
      }
    ];
    // ─────────────────────────────────────────────────────────────────────────────


    console.log(`[Scraper] Launching fetch for ${feeds.length} RSS feeds...`);
    const fetchPromises = feeds.map(async feed => {
      try {
        let url = feed.url;
        if (feed.name.includes('Google News')) {
          url = url.replace('&hl=', '+when:3d&hl=');
        }
        
        // Wrap feed parsing in a strict 6-second timeout to prevent hanging target servers
        const parsePromise = parser.parseURL(url);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout (6s)')), 6000)
        );
        
        const parsed = await Promise.race([parsePromise, timeoutPromise]);
        console.log(`[Scraper] Fetched ${parsed.items.length} items from ${feed.name}`);
        return parsed.items.map(item => ({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || item.isoDate,
          content: item.content || item.contentSnippet,
          source: feed.name.includes('Google') ? 'Google News Indexer' : feed.name,
          imageUrl: extractImage(item)
        }));
      } catch (err) {
        console.error(`[Scraper Error] Failed to fetch feed ${feed.name}:`, err.message);
        return [];
      }
    });
    const results = await Promise.all(fetchPromises);
    let allArticles = results.flat();

    // Programmatic Cutoff Filter: Keep articles from the last 7 days (covers weekends & public holidays)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);
    allArticles = allArticles.filter(art => {
      const d = new Date(art.pubDate);
      return !isNaN(d.getTime()) && d >= cutoffDate;
    });

    console.log(`[Scraper] Aggregated ${allArticles.length} recent raw articles (last 7 days).`);

    if (allArticles.length === 0) {
      return { success: true, count: 0, articles: [], message: 'No recent articles found in feeds (last 7 days)' };
    }

    // Step 1: Jaccard-based Deduplication
    console.log('[Deduplicator] Running similarity clustering...');
    const uniqueArticles = [];
    const titleTokenSets = [];

    for (const art of allArticles) {
      const tokens = getTokens(art.title);
      let isDuplicate = false;

      for (let i = 0; i < uniqueArticles.length; i++) {
        const sim = jaccardSimilarity(tokens, titleTokenSets[i]);
        if (sim > 0.3) { // 30% overlap in key words indicates duplicate/near-duplicate news
          isDuplicate = true;
          // Keep the one with longer content description
          if ((art.content || '').length > (uniqueArticles[i].content || '').length) {
            uniqueArticles[i] = art;
            titleTokenSets[i] = tokens;
          }
          break;
        }
      }

      if (!isDuplicate) {
        uniqueArticles.push(art);
        titleTokenSets.push(tokens);
      }
    }
    console.log(`[Deduplicator] Retained ${uniqueArticles.length} unique articles out of ${allArticles.length}.`);

    // Step 2: Relevance Scoring & Sorting
    console.log('[Relevance Filter] Scoring unique articles...');
    const scoredArticles = uniqueArticles.map((art, index) => {
      const score = scoreRelevance(art.title, art.content);
      return { ...art, localId: index, relevanceScore: score };
    });

    // Sort by relevance score desc
    scoredArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Category-diversified candidate selection with per-bucket caps
    // Dispute categories (RERA, Litigation) are capped at 3 each to prevent them dominating
    // PRD target: top 50 relevant articles across all 8 categories
    const BUCKET_LIMIT = 8; // default cap per category
    const DISPUTE_BUCKET_LIMIT = 3; // lower cap for RERA and Litigation
    const bucketCounts = {};
    const candidates = [];
    for (const art of scoredArticles) {
      if (art.relevanceScore <= 2) continue;
      const bucket = detectTopicBucket(art.title);
      bucketCounts[bucket] = (bucketCounts[bucket] || 0);
      const cap = (bucket === 'RERA' || bucket === 'Litigation') ? DISPUTE_BUCKET_LIMIT : BUCKET_LIMIT;
      if (bucketCounts[bucket] < cap) {
        candidates.push({ ...art, detectedBucket: bucket });
        bucketCounts[bucket]++;
      }
      if (candidates.length >= 50) break; // PRD: hard cap at 50 candidates
    }

    console.log(`[Relevance Filter] Selected ${candidates.length} diversified candidates across buckets:`, JSON.stringify(bucketCounts));

    if (candidates.length === 0) {
      return { success: true, count: 0, articles: [], message: 'No relevant real estate articles identified.' };
    }

    // Step 3: Batch candidates and call Groq API in parallel batches of 6
    console.log('[AI Processor] Calling Groq with dual-key rotation...');
    const batchSize = 6;
    const processedArticles = [];
    let keysStatusReport = {
      totalKeys: groqKeys.length,
      activeKeyIndex,
      failovers: failoverLogs
    };

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      console.log(`[AI Processor] Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(candidates.length / batchSize)} (Size: ${batch.length})...`);
      
      const systemPrompt = `You are a professional Real Estate Intelligence AI Analyzer.
Analyze the provided batch of Indian real estate news articles and return structured data.
You MUST output a JSON object containing a "results" key which maps to an array of objects.

For EACH article in the input list, return an object in the "results" array.
Verify if the article is truly related to Indian real estate. Set "relevant": false if it's not (e.g. general economy, international news, other industries).

CRITICAL DIVERSITY RULE: Each batch will contain articles from DIFFERENT topic categories (Project Launch, Funding, Infrastructure, Government Policy, RERA, Litigation, Land Acquisition, Redevelopment). You MUST mark ALL clearly real-estate-relevant articles as relevant:true, regardless of category. Do NOT mark articles as irrelevant simply because they belong to RERA or regulatory topics — but also do NOT favour RERA articles over others. Aim for balanced coverage across all categories present in the batch.

If "relevant" is true, extract and process these fields:
1. "originalId": (Integer) Match the input article's localId.
2. "relevant": true
3. "headline": Rewritten highly professional, editorial-grade news headline (max 15 words).
4. "builder": Builder/developer company name. Use "—" if not mentioned or not applicable.
5. "city": Primary city mentioned (e.g. "Mumbai", "Thane", "Bengaluru", "Pune", "Delhi", "Gurugram", "Noida"). Use "—" if statewide/national.
6. "state": State name (e.g. "Maharashtra", "Karnataka", "Haryana", "Delhi NCR"). Use "—" if national.
7. "category": EXACTLY one of: "Project Launch", "Land Acquisition", "Redevelopment", "RERA", "Funding", "Government Policy", "Infrastructure", "Litigation".
8. "summary": A concise 100-150 word summary written in a clean, formal, journalistic tone. Avoid hype or buzzwords. Report numbers, percentages, timelines, and facts objectively. If the input article title or content is in Hindi, you MUST translate it and write both the "headline" and the "summary" in English.
9. "priorityScore": Integer (1 to 10) representing the news impact:
   - 8 to 10: State/National policies, mega funding (>500 Cr), massive infrastructure expansions, or landmark court orders.
   - 5 to 7: Standard builder launches, land acquisitions, cluster redevelopments, RERA regulatory penalties.
   - 1 to 4: Minor local road closures, small residential project handovers, local property rate discussions.

You must return valid JSON matching this schema:
{
  "results": [
    {
      "originalId": 0,
      "relevant": true,
      "headline": "...",
      "builder": "...",
      "city": "...",
      "state": "...",
      "category": "...",
      "summary": "...",
      "priorityScore": 7
    }
  ]
}`;

      const userPrompt = `Here is the batch of articles to analyze:
${JSON.stringify(batch.map(b => ({ localId: b.localId, title: b.title, content: b.content, source: b.source, pubDate: b.pubDate })))}`;

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      try {
        const { data, keyUsed } = await callGroqWithFailover(messages, groqKeys);
        
        let batchResults;
        try {
          // Parse JSON from response
          const contentText = data.choices[0].message.content;
          batchResults = JSON.parse(contentText).results || [];
        } catch (parseErr) {
          console.error('[AI Processor Error] Failed to parse JSON from Groq response:', parseErr.message);
          console.log('Raw response:', data.choices[0].message.content);
          continue;
        }

        // Map back metadata (link, original date, images, etc.)
        for (const item of batchResults) {
          if (item.relevant) {
            const original = batch.find(b => b.localId === item.originalId);
            if (original) {
              // Category-specific default images (served locally)
              const stockImages = {
                'Project Launch': '/images/categories/project-launch.png',
                'Land Acquisition': '/images/categories/land-acquisition.png',
                'Redevelopment': '/images/categories/redevelopment.png',
                'RERA': '/images/categories/rera.png',
                'Funding': '/images/categories/funding.png',
                'Government Policy': '/images/categories/government-policy.png',
                'Infrastructure': '/images/categories/infrastructure.png',
                'Litigation': '/images/categories/litigation.png'
              };

              processedArticles.push({
                id: Date.now() + Math.random(),
                headline: item.headline,
                summary: item.summary,
                builder: item.builder,
                project: original.title.includes(' - ') ? original.title.split(' - ')[0] : 'Project Update',
                city: item.city,
                state: item.state,
                category: item.category,
                date: new Date(original.pubDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
                source: original.source,
                link: original.link,
                originalTitle: original.title,
                originalLink: normalizeUrl(original.link),
                img: original.imageUrl || stockImages[item.category] || '/images/categories/project-launch.png',
                priorityScore: item.priorityScore || 5,
                rera: original.title.includes('RERA') ? 'Details in Body' : '—',
                rerastatus: item.category === 'RERA' ? 'Regulatory Review' : 'Active',
                status: ({
                  'Project Launch': 'New Launch',
                  'Land Acquisition': 'Acquisition Complete',
                  'Redevelopment': 'Redevelopment',
                  'RERA': 'Regulatory Update',
                  'Funding': 'Funding Closed',
                  'Government Policy': 'Policy Approved',
                  'Infrastructure': 'Infrastructure Update',
                  'Litigation': 'Litigation Update'
                })[item.category] || 'New Launch'
              });
            }
          }
        }
      } catch (batchErr) {
        console.error('[AI Processor Error] Failed to process batch:', batchErr.message);
      }
      // Add a 1200ms cooling delay between batches to respect Groq rate limits (6000 TPM)
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    // Sort by priorityScore desc
    processedArticles.sort((a, b) => b.priorityScore - a.priorityScore);

    // Limit to top 50 as per PRD
    const topArticles = processedArticles.slice(0, 50);
    console.log(`[AI Processor] Completed processing. Shortlisted ${topArticles.length} top news items.`);

    // Update active index log for client status
    keysStatusReport.activeKeyIndex = activeKeyIndex;

    return {
      success: true,
      count: topArticles.length,
      articles: topArticles,
      keysStatus: keysStatusReport,
      totalRawScraped: allArticles.length,
      totalUniqueDeduplicated: uniqueArticles.length
    };
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const reqHeaders = event.headers || {};
  
  // Keys come exclusively from Netlify environment variables (set in Netlify Dashboard > Site Settings > Environment Variables)
  // NEVER hardcode API keys in source code — they get committed to version control and exposed
  const groqKeys = [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2
  ].filter(Boolean);

  try {
    const result = await runPipeline(groqKeys);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error('[Scraper & AI Fatal Error]:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message || err })
    };
  }
};

module.exports.runPipeline = runPipeline;
