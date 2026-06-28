const dbHelper = require('./db-helper');

async function readCampaigns() {
  const data = await dbHelper.getCampaigns();
  if (!data || !data.campaigns) {
    return { campaigns: [] };
  }
  return data;
}

async function writeCampaigns(data) {
  return await dbHelper.setCampaigns(data);
}

exports.handler = async (event, context) => {
  const query = event.queryStringParameters || {};
  const { type, campaignId, contactId, url } = query;

  try {
    if (campaignId) {
      const db = await readCampaigns();
      const campaign = db.campaigns.find(c => c.id === campaignId);
      
      if (campaign) {
        if (type === 'open') {
          // Track unique email open
          if (!campaign.openTracking) campaign.openTracking = [];
          if (!campaign.openTracking.includes(contactId)) {
            campaign.openTracking.push(contactId || 'anon_' + Math.random().toString(36).substr(2, 5));
            campaign.stats.opened = campaign.openTracking.length;
            await writeCampaigns(db);
          }
        } else if (type === 'click') {
          // Track unique click
          if (!campaign.clickTracking) campaign.clickTracking = [];
          if (!campaign.clickTracking.includes(contactId)) {
            campaign.clickTracking.push(contactId || 'anon_' + Math.random().toString(36).substr(2, 5));
            campaign.stats.clicked = campaign.clickTracking.length;
            await writeCampaigns(db);
          }
        }
      }
    }

    // 1. OPEN PIXEL RESPONSE
    if (type === 'open') {
      const pixelBase64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const pixelBuffer = Buffer.from(pixelBase64, 'base64');
      
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'image/gif',
          'Content-Length': pixelBuffer.length.toString(),
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        },
        body: pixelBuffer.toString('binary'),
        isBase64Encoded: true
      };
    }

    // 2. CLICK REDIRECT RESPONSE
    if (type === 'click' && url) {
      return {
        statusCode: 302,
        headers: {
          'Location': decodeURIComponent(url)
        },
        body: `Redirecting to ${url}...`
      };
    }

    // Fallback response
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Tracking logged.'
    };

  } catch (err) {
    console.error('[Tracking Error]:', err);
    // If click redirect fails, at least attempt to go to the url
    if (type === 'click' && url) {
      return {
        statusCode: 302,
        headers: { 'Location': decodeURIComponent(url) },
        body: `Redirecting to ${url}...`
      };
    }
    return {
      statusCode: 500,
      body: 'Internal tracking error'
    };
  }
};
