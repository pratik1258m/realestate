const fs = require('fs');
const path = require('path');

let createClient;
try {
  createClient = require('@supabase/supabase-js').createClient;
} catch (e) {
  createClient = null;
}

// 1. Initialize Supabase if credentials are provided in env
let supabase = null;
if (createClient && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    console.log('[DB Helper] Supabase initialized successfully.');
  } catch (err) {
    console.error('[DB Helper] Supabase connection failed:', err.message);
  }
}

// 2. Initialize Netlify Blobs if on Netlify
let getStore = null;
try {
  if (process.env.NETLIFY) {
    getStore = require('@netlify/blobs').getStore;
  }
} catch (e) {
  // Offline
}

const LOCAL_RECIPIENTS = path.join(__dirname, '../../recipients.json');
const LOCAL_CAMPAIGNS = path.join(__dirname, '../../campaigns.json');

async function getRecipients() {
  // Tier 1: Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('key_value_store')
        .select('value')
        .eq('key', 'recipients')
        .single();
      if (!error && data) return data.value;
    } catch (err) {
      console.error('[DB Helper] Supabase read recipients error:', err.message);
    }
  }

  // Tier 2: Netlify Blobs
  if (getStore) {
    try {
      const store = getStore('real_estate_platform');
      const raw = await store.get('recipients_db');
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.error('[DB Helper] Netlify Blobs read recipients error:', err.message);
    }
  }

  // Tier 3: Local JSON File
  if (fs.existsSync(LOCAL_RECIPIENTS)) {
    try {
      return JSON.parse(fs.readFileSync(LOCAL_RECIPIENTS, 'utf8'));
    } catch (e) {
      console.error('[DB Helper] Local recipients file read error:', e.message);
    }
  }

  return { groups: [] };
}

async function setRecipients(data) {
  // Sync counts
  if (data.groups) {
    data.groups.forEach(g => {
      g.count = g.contacts ? g.contacts.length : 0;
    });
  }

  // Tier 1: Supabase
  if (supabase) {
    try {
      const { error } = await supabase
        .from('key_value_store')
        .upsert({ key: 'recipients', value: data });
      if (!error) return true;
    } catch (err) {
      console.error('[DB Helper] Supabase write recipients error:', err.message);
    }
  }

  // Tier 2: Netlify Blobs
  if (getStore) {
    try {
      const store = getStore('real_estate_platform');
      await store.set('recipients_db', JSON.stringify(data));
      return true;
    } catch (err) {
      console.error('[DB Helper] Netlify Blobs write recipients error:', err.message);
    }
  }

  // Tier 3: Local JSON File
  try {
    fs.writeFileSync(LOCAL_RECIPIENTS, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[DB Helper] Local recipients file write error:', err.message);
    return false;
  }
}

async function getCampaigns() {
  // Tier 1: Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('key_value_store')
        .select('value')
        .eq('key', 'campaigns')
        .single();
      if (!error && data) return data.value;
    } catch (err) {
      console.error('[DB Helper] Supabase read campaigns error:', err.message);
    }
  }

  // Tier 2: Netlify Blobs
  if (getStore) {
    try {
      const store = getStore('real_estate_platform');
      const raw = await store.get('campaigns_db');
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.error('[DB Helper] Netlify Blobs read campaigns error:', err.message);
    }
  }

  // Tier 3: Local JSON File
  if (fs.existsSync(LOCAL_CAMPAIGNS)) {
    try {
      return JSON.parse(fs.readFileSync(LOCAL_CAMPAIGNS, 'utf8'));
    } catch (e) {
      console.error('[DB Helper] Local campaigns file read error:', e.message);
    }
  }

  return { campaigns: [] };
}

async function setCampaigns(data) {
  // Tier 1: Supabase
  if (supabase) {
    try {
      const { error } = await supabase
        .from('key_value_store')
        .upsert({ key: 'campaigns', value: data });
      if (!error) return true;
    } catch (err) {
      console.error('[DB Helper] Supabase write campaigns error:', err.message);
    }
  }

  // Tier 2: Netlify Blobs
  if (getStore) {
    try {
      const store = getStore('real_estate_platform');
      await store.set('campaigns_db', JSON.stringify(data));
      return true;
    } catch (err) {
      console.error('[DB Helper] Netlify Blobs write campaigns error:', err.message);
    }
  }

  // Tier 3: Local JSON File
  try {
    fs.writeFileSync(LOCAL_CAMPAIGNS, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[DB Helper] Local campaigns file write error:', err.message);
    return false;
  }
}

module.exports = {
  getRecipients,
  setRecipients,
  getCampaigns,
  setCampaigns
};
