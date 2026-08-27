// ============================================================
// Progsu LinkedIn Outreach Assistant — Background Service Worker
// ============================================================
// Manages storage for contacted profiles and message templates.
// Acts as the central hub that content scripts and the popup
// communicate with via chrome.runtime messaging.
// ============================================================

// --- Default template used on first install ---
const DEFAULT_TEMPLATE = `Hi {{firstName}},

I came across your profile and was really impressed by your work at {{company}}. I'd love to connect and explore how we might collaborate.

Looking forward to hearing from you!`;

// --- Install / Update handler ---
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      templates: [
        { id: generateId(), name: 'Default Outreach', body: DEFAULT_TEMPLATE, isDefault: true }
      ],
      contactedProfiles: {},   // { profileUrl: { name, dateSent, templateUsed, sentBy } }
      settings: {
        showBadge: true,        // Show "already contacted" badge on profiles
        showMarkers: true,      // Tag already-contacted people in search/list views
        autoPaste: true,        // Automatically paste when chat opens
        teamName: 'Team Member' // Name of the person using this extension instance
      }
    });
  }
});

// --- Message router ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    GET_TEMPLATES:        handleGetTemplates,
    SAVE_TEMPLATES:       handleSaveTemplates,
    GET_CONTACTED:        handleGetContacted,
    MARK_CONTACTED:       handleMarkContacted,
    REMOVE_CONTACTED:     handleRemoveContacted,
    CHECK_PROFILE:        handleCheckProfile,
    GET_SETTINGS:         handleGetSettings,
    SAVE_SETTINGS:        handleSaveSettings,
    EXPORT_CONTACTED:     handleExportContacted,
    IMPORT_CONTACTED:     handleImportContacted,
    CLEAR_ALL_CONTACTED:  handleClearAllContacted,
    GET_STATS:            handleGetStats
  };

  const handler = handlers[message.type];
  if (handler) {
    handler(message, sender).then(sendResponse);
    return true; // keeps the message channel open for async response
  }
});

// --- Handler implementations ---

async function handleGetTemplates() {
  const { templates } = await chrome.storage.local.get('templates');
  return { success: true, templates: templates || [] };
}

async function handleSaveTemplates(msg) {
  await chrome.storage.local.set({ templates: msg.templates });
  return { success: true };
}

async function handleGetContacted() {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  return { success: true, contactedProfiles: contactedProfiles || {} };
}

async function handleMarkContacted(msg) {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  profiles[msg.profileUrl] = {
    name: msg.name || 'Unknown',
    dateSent: new Date().toISOString(),
    templateUsed: msg.templateName || 'Unknown',
    sentBy: msg.sentBy || 'Unknown'
  };
  await chrome.storage.local.set({ contactedProfiles: profiles });
  return { success: true };
}

async function handleRemoveContacted(msg) {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  delete profiles[msg.profileUrl];
  await chrome.storage.local.set({ contactedProfiles: profiles });
  return { success: true };
}

async function handleCheckProfile(msg) {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  const match = profiles[msg.profileUrl];
  return { success: true, contacted: !!match, details: match || null };
}

async function handleGetSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { success: true, settings: settings || {} };
}

async function handleSaveSettings(msg) {
  await chrome.storage.local.set({ settings: msg.settings });
  return { success: true };
}

async function handleExportContacted() {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  return { success: true, data: JSON.stringify(contactedProfiles || {}, null, 2) };
}

async function handleImportContacted(msg) {
  try {
    const incoming = JSON.parse(msg.data);
    const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
    const merged = { ...(contactedProfiles || {}), ...incoming };
    await chrome.storage.local.set({ contactedProfiles: merged });
    return { success: true, count: Object.keys(incoming).length };
  } catch (e) {
    return { success: false, error: 'Invalid JSON data' };
  }
}

async function handleClearAllContacted() {
  await chrome.storage.local.set({ contactedProfiles: {} });
  return { success: true };
}

async function handleGetStats() {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  const total = Object.keys(profiles).length;
  const today = new Date().toISOString().split('T')[0];
  const todayCount = Object.values(profiles).filter(
    p => p.dateSent && p.dateSent.startsWith(today)
  ).length;
  return { success: true, total, todayCount };
}

// --- Utility ---
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
