const dbHelper = require('./db-helper');

const DEFAULT_GROUPS = [
  { id: 'g1', name: 'Builder Clients', count: 0, desc: 'Developers & promoters you advise', contacts: [] },
  { id: 'g2', name: 'Broker Groups', count: 0, desc: 'Channel partners across MMR & Pune', contacts: [] },
  { id: 'g3', name: 'Investor Groups', count: 0, desc: 'HNI & retail investor circles', contacts: [] },
  { id: 'g4', name: 'Internal Team', count: 0, desc: 'Office & field staff', contacts: [] }
];

async function readData() {
  const data = await dbHelper.getRecipients();
  if (!data || !data.groups || data.groups.length === 0) {
    return { groups: DEFAULT_GROUPS };
  }
  return data;
}

async function writeData(data) {
  return await dbHelper.setRecipients(data);
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const db = await readData();

    // GET /api/recipients
    if (event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, groups: db.groups })
      };
    }

    // POST /api/recipients
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action } = body;

      // 1. ADD NEW GROUP
      if (action === 'create_group') {
        const { name, desc } = body;
        if (!name) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Group name required' }) };
        
        const newGroup = {
          id: 'g_' + Date.now(),
          name,
          desc: desc || '',
          count: 0,
          contacts: []
        };
        db.groups.push(newGroup);
        await writeData(db);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, groups: db.groups }) };
      }

      // 2. DELETE GROUP
      if (action === 'delete_group') {
        const { groupId } = body;
        db.groups = db.groups.filter(g => g.id !== groupId);
        await writeData(db);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, groups: db.groups }) };
      }

      // 3. ADD INDIVIDUAL CONTACT TO GROUP
      if (action === 'add_contact') {
        const { groupId, name, email, whatsapp } = body;
        const group = db.groups.find(g => g.id === groupId);
        if (!group) return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Group not found' }) };

        const newContact = {
          id: 'c_' + Date.now(),
          name: name || 'Unnamed Contact',
          email: email || '',
          whatsapp: whatsapp || '',
          addedAt: new Date().toISOString()
        };
        group.contacts.push(newContact);
        await writeData(db);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, groups: db.groups }) };
      }

      // 4. IMPORT CSV / MASS UPLOAD CONTACTS
      if (action === 'import_contacts') {
        const { groupId, contacts } = body; // Array of {name, email, whatsapp}
        const group = db.groups.find(g => g.id === groupId);
        if (!group) return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Group not found' }) };

        if (!Array.isArray(contacts)) {
          return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Contacts list must be an array' }) };
        }

        const addedContacts = contacts.map(c => ({
          id: 'c_' + Math.random().toString(36).substr(2, 9),
          name: c.name || 'Unnamed Contact',
          email: c.email || '',
          whatsapp: c.whatsapp || '',
          addedAt: new Date().toISOString()
        }));

        group.contacts.push(...addedContacts);
        await writeData(db);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, count: addedContacts.length, groups: db.groups }) };
      }

      // 5. UPDATE CONTACT
      if (action === 'edit_contact') {
        const { groupId, contactId, name, email, whatsapp } = body;
        const group = db.groups.find(g => g.id === groupId);
        if (!group) return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Group not found' }) };

        const contact = group.contacts.find(c => c.id === contactId);
        if (!contact) return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Contact not found' }) };

        contact.name = name || contact.name;
        contact.email = email !== undefined ? email : contact.email;
        contact.whatsapp = whatsapp !== undefined ? whatsapp : contact.whatsapp;

        await writeData(db);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, groups: db.groups }) };
      }

      // 6. DELETE CONTACT
      if (action === 'delete_contact') {
        const { groupId, contactId } = body;
        const group = db.groups.find(g => g.id === groupId);
        if (!group) return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Group not found' }) };

        group.contacts = group.contacts.filter(c => c.id !== contactId);
        await writeData(db);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, groups: db.groups }) };
      }
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'Method not allowed' })
    };

  } catch (err) {
    console.error('[Recipients Function Error]:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message || err })
    };
  }
};
