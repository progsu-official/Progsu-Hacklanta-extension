// ============================================================
// Progsu LinkedIn Outreach Assistant — Popup Script
// ============================================================
// Handles the popup UI: template CRUD, contacted profiles list,
// settings management, import/export.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // ---- State ----
  let templates = [];
  let contactedProfiles = {};
  let settings = {};
  let editingTemplateId = null;

  // ---- DOM refs ----
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  // Templates
  const templateList = document.getElementById('template-list');
  const templateEditor = document.getElementById('template-editor');
  const editorTitle = document.getElementById('editor-title');
  const templateNameInput = document.getElementById('template-name');
  const templateBodyInput = document.getElementById('template-body');
  const templateDefaultCheck = document.getElementById('template-default');
  const btnAddTemplate = document.getElementById('btn-add-template');
  const btnCloseEditor = document.getElementById('btn-close-editor');
  const btnCancelEdit = document.getElementById('btn-cancel-edit');
  const btnSaveTemplate = document.getElementById('btn-save-template');
  const btnPasteToChat = document.getElementById('btn-paste-to-chat');

  // Contacted
  const contactedList = document.getElementById('contacted-list');
  const contactedSearch = document.getElementById('contacted-search');
  const btnExport = document.getElementById('btn-export');
  const btnImport = document.getElementById('btn-import');
  const btnClearAll = document.getElementById('btn-clear-all');
  const importModal = document.getElementById('import-modal');
  const importData = document.getElementById('import-data');
  const btnCancelImport = document.getElementById('btn-cancel-import');
  const btnConfirmImport = document.getElementById('btn-confirm-import');

  // Settings
  const settingTeamName = document.getElementById('setting-team-name');
  const settingAutoPaste = document.getElementById('setting-auto-paste');
  const settingShowBadge = document.getElementById('setting-show-badge');
  const btnSaveSettings = document.getElementById('btn-save-settings');

  // Stats
  const statToday = document.getElementById('stat-today');
  const statTotal = document.getElementById('stat-total');

  // ---- Init ----
  loadAll();

  // ---- Tab switching ----
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      document.getElementById(`tab-${tab}`).classList.add('active');
    });
  });

  // ---- Safe message sender (handles service worker wake-up) ----
  async function sendMsg(msg, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await chrome.runtime.sendMessage(msg);
        return res;
      } catch (e) {
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }
    return { success: false };
  }

  // ---- Load data from background ----
  async function loadAll() {
    await Promise.all([loadTemplates(), loadContacted(), loadSettings(), loadStats()]);
  }

  async function loadTemplates() {
    const res = await sendMsg({ type: 'GET_TEMPLATES' });
    if (res.success) {
      templates = res.templates;
      renderTemplates();
    }
  }

  async function loadContacted() {
    const res = await sendMsg({ type: 'GET_CONTACTED' });
    if (res.success) {
      contactedProfiles = res.contactedProfiles;
      renderContacted();
    }
  }

  async function loadSettings() {
    const res = await sendMsg({ type: 'GET_SETTINGS' });
    if (res.success) {
      settings = res.settings;
      settingTeamName.value = settings.teamName || '';
      settingAutoPaste.checked = settings.autoPaste !== false;
      settingShowBadge.checked = settings.showBadge !== false;
    }
  }

  async function loadStats() {
    const res = await sendMsg({ type: 'GET_STATS' });
    if (res.success) {
      statToday.textContent = res.todayCount;
      statTotal.textContent = res.total;
    }
  }

  // ---- Render templates ----
  function renderTemplates() {
    if (templates.length === 0) {
      templateList.innerHTML = `
        <div class="empty-state">
          <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <p>No templates yet. Click "New" to create one.</p>
        </div>
      `;
      return;
    }

    templateList.innerHTML = templates.map(t => `
      <div class="template-card" data-id="${t.id}">
        <div class="template-card-info">
          <div class="template-card-name">
            ${escapeHtml(t.name)}
            ${t.isDefault ? '<span class="template-badge">Default</span>' : ''}
          </div>
          <div class="template-card-preview">${escapeHtml(t.body.substring(0, 80))}${t.body.length > 80 ? '…' : ''}</div>
        </div>
        <div class="template-card-actions">
          <button class="edit-btn" data-id="${t.id}" title="Edit template"
                  aria-label="Edit template ${escapeHtml(t.name)}">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
            </svg>
          </button>
          <button class="delete-btn" data-id="${t.id}" title="Delete template"
                  aria-label="Delete template ${escapeHtml(t.name)}">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    // Wire edit buttons
    templateList.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditor(btn.dataset.id);
      });
    });

    // Wire delete buttons
    templateList.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTemplate(btn.dataset.id);
      });
    });

    // Click card to edit
    templateList.querySelectorAll('.template-card').forEach(card => {
      card.addEventListener('click', () => openEditor(card.dataset.id));
    });
  }

  // ---- Template editor ----
  function openEditor(id = null) {
    editingTemplateId = id;
    const template = id ? templates.find(t => t.id === id) : null;

    editorTitle.textContent = template ? 'Edit Template' : 'New Template';
    templateNameInput.value = template ? template.name : '';
    templateBodyInput.value = template ? template.body : '';
    templateDefaultCheck.checked = template ? template.isDefault : false;

    templateEditor.classList.remove('hidden');
    templateNameInput.focus();
  }

  function closeEditor() {
    templateEditor.classList.add('hidden');
    editingTemplateId = null;
    // Return focus to the control that opens the editor, so keyboard users
    // are not dropped at the top of the document
    btnAddTemplate.focus();
  }

  btnAddTemplate.addEventListener('click', () => openEditor());
  btnCloseEditor.addEventListener('click', closeEditor);
  btnCancelEdit.addEventListener('click', closeEditor);

  btnSaveTemplate.addEventListener('click', async () => {
    const name = templateNameInput.value.trim();
    const body = templateBodyInput.value.trim();
    const isDefault = templateDefaultCheck.checked;

    if (!name || !body) {
      showToast('Please fill in both name and message body');
      return;
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      templates.forEach(t => t.isDefault = false);
    }

    if (editingTemplateId) {
      // Update
      const idx = templates.findIndex(t => t.id === editingTemplateId);
      if (idx !== -1) {
        templates[idx] = { ...templates[idx], name, body, isDefault };
      }
    } else {
      // Create
      templates.push({
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
        name, body, isDefault
      });
    }

    await sendMsg({ type: 'SAVE_TEMPLATES', templates });

    // Notify content scripts
    notifyContentScripts('TEMPLATES_UPDATED');

    closeEditor();
    renderTemplates();
    showToast('Template saved!');
  });

  // ---- "Paste to LinkedIn Chat" ----
  btnPasteToChat.addEventListener('click', async () => {
    const template = templates.find(t => t.isDefault) || templates[0];
    if (!template) {
      showToast('Create a template first');
      return;
    }

    const tab = await getLinkedInTab();
    if (!tab) {
      showToast('Open a LinkedIn tab first');
      return;
    }

    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      showToast('Reload the LinkedIn tab, then try again');
      return;
    }

    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'PASTE_TEMPLATE_NOW', template });
    } catch (e) {
      showToast('Reload the LinkedIn tab, then try again');
      return;
    }

    if (res && res.success) {
      showToast('Pasted into the LinkedIn chat!');
      // Closing the popup hands focus back to the page, which is what lets the
      // content script finish the paste using native editing commands.
      setTimeout(() => window.close(), 800);
    } else {
      showToast((res && res.error) || 'No LinkedIn message box found — open a chat first');
    }
  });

  async function deleteTemplate(id) {
    templates = templates.filter(t => t.id !== id);
    await sendMsg({ type: 'SAVE_TEMPLATES', templates });
    notifyContentScripts('TEMPLATES_UPDATED');
    renderTemplates();
    showToast('Template deleted');
  }

  // ---- Render contacted profiles ----
  function renderContacted(filter = '') {
    const entries = Object.entries(contactedProfiles);

    if (entries.length === 0) {
      contactedList.innerHTML = `
        <div class="empty-state">
          <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
          </svg>
          <p>No profiles contacted yet.</p>
        </div>
      `;
      return;
    }

    const filtered = filter
      ? entries.filter(([url, data]) =>
          data.name.toLowerCase().includes(filter.toLowerCase()) ||
          url.toLowerCase().includes(filter.toLowerCase())
        )
      : entries;

    if (filtered.length === 0) {
      contactedList.innerHTML = `<div class="empty-state"><p>No matching profiles found.</p></div>`;
      return;
    }

    // Sort by date (most recent first)
    filtered.sort((a, b) => new Date(b[1].dateSent) - new Date(a[1].dateSent));

    contactedList.innerHTML = filtered.map(([url, data]) => {
      const initials = getInitials(data.name);
      const date = formatDate(data.dateSent);
      return `
        <div class="contacted-card">
          <div class="contacted-avatar">${initials}</div>
          <div class="contacted-info">
            <div class="contacted-name" title="${escapeHtml(url)}">${escapeHtml(data.name)}</div>
            <div class="contacted-meta">
              <span>${date}</span>
              <span>by ${escapeHtml(data.sentBy || 'Unknown')}</span>
            </div>
          </div>
          <button class="contacted-remove" data-url="${escapeHtml(url)}" title="Remove from list"
                  aria-label="Remove ${escapeHtml(data.name)} from the contacted list">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      `;
    }).join('');

    // Wire remove buttons
    contactedList.querySelectorAll('.contacted-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.dataset.url;
        await sendMsg({ type: 'REMOVE_CONTACTED', profileUrl: url });
        delete contactedProfiles[url];
        renderContacted(contactedSearch.value);
        loadStats();
        showToast('Profile removed');
      });
    });
  }

  // Search
  contactedSearch.addEventListener('input', () => {
    renderContacted(contactedSearch.value);
  });

  // Export
  btnExport.addEventListener('click', async () => {
    const res = await sendMsg({ type: 'EXPORT_CONTACTED' });
    if (res.success) {
      // Copy to clipboard
      try {
        await navigator.clipboard.writeText(res.data);
        showToast('Exported to clipboard! Share with your team.');
      } catch (e) {
        // Fallback: download as file
        const blob = new Blob([res.data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `progsu-contacted-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Downloaded as JSON file');
      }
    }
  });

  // Import
  btnImport.addEventListener('click', () => {
    importModal.classList.remove('hidden');
    importData.value = '';
    importData.focus();
  });

  btnCancelImport.addEventListener('click', () => {
    importModal.classList.add('hidden');
  });

  btnConfirmImport.addEventListener('click', async () => {
    const data = importData.value.trim();
    if (!data) {
      showToast('Please paste JSON data first');
      return;
    }
    const res = await sendMsg({ type: 'IMPORT_CONTACTED', data });
    if (res.success) {
      importModal.classList.add('hidden');
      await loadContacted();
      await loadStats();
      showToast(`Imported ${res.count} profiles!`);
    } else {
      showToast(res.error || 'Import failed');
    }
  });

  // Clear all
  btnClearAll.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear ALL contacted profiles? This cannot be undone.')) {
      await sendMsg({ type: 'CLEAR_ALL_CONTACTED' });
      contactedProfiles = {};
      renderContacted();
      await loadStats();
      showToast('All profiles cleared');
    }
  });

  // ---- Settings ----
  btnSaveSettings.addEventListener('click', async () => {
    settings = {
      teamName: settingTeamName.value.trim() || 'Team Member',
      autoPaste: settingAutoPaste.checked,
      showBadge: settingShowBadge.checked
    };
    await sendMsg({ type: 'SAVE_SETTINGS', settings });
    notifyContentScripts('SETTINGS_UPDATED');
    showToast('Settings saved!');
  });

  // ---- Utility functions ----

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatDate(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function getInitials(name) {
    if (!name || name === 'Unknown') return '?';
    const parts = name.trim().split(' ');
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    // Announced by screen readers; role="status" never moves focus
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  async function getLinkedInTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('linkedin.com')) return tab;
    } catch (e) { /* tab may not exist */ }
    return null;
  }

  // The content script is only auto-injected on page load, so a LinkedIn tab
  // that was already open when the extension was installed or reloaded has no
  // script in it. Inject on demand instead of silently doing nothing.
  async function ensureContentScript(tabId) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (pong && pong.success) return true;
    } catch (e) { /* not injected yet */ }

    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
      await new Promise(r => setTimeout(r, 250));
      return true;
    } catch (e) {
      return false;
    }
  }

  async function notifyContentScripts(type) {
    const tab = await getLinkedInTab();
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type });
    } catch (e) { /* content script not loaded in that tab */ }
  }
});
