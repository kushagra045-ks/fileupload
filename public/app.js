(function () {
  "use strict";

  const API_BASE = (window.API_BASE || '').replace(/\/$/, '');
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  let socket = null;

  function showToast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2600);
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fmtTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return new Date(ts).toLocaleDateString();
  }

  function iconFor(type) {
    type = type || '';
    if (type.startsWith('image/')) return icon('M4 6h16v13H4z M4 15l4-4 3 3 5-6 4 5');
    if (type.startsWith('video/')) return icon('M4 6h12v13H4z M16 10l5-3v11l-5-3');
    if (type.startsWith('audio/')) return icon('M9 18V6l10-2v12 M9 18a3 3 0 100-6 3 3 0 000 6z M19 16a3 3 0 100-6 3 3 0 000 6z');
    if (type === 'application/pdf') return icon('M6 3h9l4 4v14H6z M15 3v4h4 M9 13h1a1.5 1.5 0 010 3H9v-3z M13.5 13H15v3h-1.5z M9 17h6');
    if (type.includes('zip') || type.includes('compressed')) return icon('M6 3h12v18H6z M11 3v18 M11 6h2 M11 10h2 M11 14h2');
    return icon('M6 3h8l4 4v14H6z M14 3v4h4');
  }
  function icon(d) {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffb454" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
  }

  function genCode() {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- server limits (max size, expiry) ----------------
  let serverConfig = { maxFileMB: null, fileTtlHours: null };
  let serverConfigReady = fetch(API_BASE + '/api/config')
    .then(r => r.json())
    .then(data => { serverConfig = data; })
    .catch(() => { /* fall back silently — validation still happens server-side */ });

  function fmtMB(mb) {
    if (!mb) return '';
    return mb >= 1024 ? (mb % 1024 === 0 ? mb / 1024 : (mb / 1024).toFixed(1)) + 'GB' : mb + 'MB';
  }
  function fmtDuration(hours) {
    if (!hours) return null;
    if (hours < 1) return Math.round(hours * 60) + ' min';
    if (hours === 1) return '1 hour';
    return (Number.isInteger(hours) ? hours : hours.toFixed(1)) + ' hours';
  }
  function fmtExpiresIn(uploadedAt) {
    if (!serverConfig.fileTtlHours) return null;
    const remaining = (uploadedAt + serverConfig.fileTtlHours * 3600 * 1000) - Date.now();
    if (remaining <= 0) return 'expiring…';
    if (remaining < 60000) return 'expires in <1m';
    if (remaining < 3600000) return 'expires in ' + Math.ceil(remaining / 60000) + 'm';
    return 'expires in ' + Math.ceil(remaining / 3600000) + 'h';
  }

  // ---------------- routing ----------------
  function currentCode() {
    const m = location.hash.match(/^#\/room\/(\d{4})$/);
    return m ? m[1] : null;
  }

  window.addEventListener('hashchange', route);
  route();

  function route() {
    const code = currentCode();
    if (code) renderRoom(code);
    else renderLanding();
  }

  // ---------------- landing ----------------
  function renderLanding() {
    if (socket) { socket.disconnect(); socket = null; }

    app.innerHTML = `
      <div class="landing">
        <div class="wordmark">WAVELENGTH</div>
        <div class="tuner">
          <svg viewBox="0 0 220 220">
            <circle cx="110" cy="110" r="95" fill="none" stroke="#2a3439" stroke-width="1"/>
            <circle cx="110" cy="110" r="72" fill="none" stroke="#2a3439" stroke-width="1"/>
            <g>
              ${Array.from({ length: 29 }).map((_, i) => {
                const a = (-140 + i * 10) * Math.PI / 180;
                const r1 = 95, r2 = i % 4 === 0 ? 82 : 88;
                const x1 = 110 + r1 * Math.cos(a), y1 = 110 + r1 * Math.sin(a);
                const x2 = 110 + r2 * Math.cos(a), y2 = 110 + r2 * Math.sin(a);
                return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3a4449" stroke-width="1.2"/>`;
              }).join('')}
            </g>
            <g class="tuner-needle">
              <line x1="110" y1="110" x2="110" y2="30" stroke="#ffb454" stroke-width="2" stroke-linecap="round"/>
              <circle cx="110" cy="110" r="5" fill="#ffb454"/>
            </g>
          </svg>
        </div>
        <h1 class="headline">Tune into a frequency,<br>drop your files.</h1>
        <p class="sub">Pick a 4-digit channel. Anyone with the code sees every file the moment it lands, no accounts, no folders.</p>

        <div class="code-entry" id="codeEntry">
          ${[0, 1, 2, 3].map(i => `<input class="code-digit" id="d${i}" inputmode="numeric" maxlength="1" autocomplete="off">`).join('')}
        </div>
        <div class="error-msg" id="codeError"></div>
        <button class="btn btn-primary" id="tuneBtn" disabled>Tune in</button>

        <div class="divider-row">OR</div>
        <button class="btn btn-ghost" id="newBtn">Start a new frequency</button>
      </div>
    `;

    const digits = [0, 1, 2, 3].map(i => document.getElementById('d' + i));
    const tuneBtn = document.getElementById('tuneBtn');
    const errEl = document.getElementById('codeError');

    function currentValue() { return digits.map(d => d.value).join(''); }
    function refresh() {
      const v = currentValue();
      tuneBtn.disabled = v.length !== 4 || /\D/.test(v);
      errEl.textContent = '';
    }
    digits.forEach((d, i) => {
      d.addEventListener('input', () => {
        d.value = d.value.replace(/\D/g, '').slice(0, 1);
        if (d.value && digits[i + 1]) digits[i + 1].focus();
        refresh();
      });
      d.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !d.value && digits[i - 1]) digits[i - 1].focus();
        if (e.key === 'Enter' && !tuneBtn.disabled) tuneBtn.click();
      });
      d.addEventListener('paste', (e) => {
        const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
        if (text.length) {
          e.preventDefault();
          text.split('').forEach((ch, idx) => { if (digits[idx]) digits[idx].value = ch; });
          (digits[Math.min(text.length, 4) - 1] || digits[3]).focus();
          refresh();
        }
      });
    });
    digits[0].focus();

    tuneBtn.addEventListener('click', () => {
      const v = currentValue();
      if (v.length === 4) location.hash = '#/room/' + v;
    });

    document.getElementById('newBtn').addEventListener('click', () => {
      location.hash = '#/room/' + genCode();
    });
  }

  // ---------------- room ----------------
  const roomState = {};

  function renderRoom(code) {
    if (socket) { socket.disconnect(); socket = null; }
    if (roomState.tickTimer) { clearInterval(roomState.tickTimer); roomState.tickTimer = null; }
    roomState.code = code;
    roomState.files = [];
    roomState.uploading = []; // { tempId, name, size, progress }

    app.innerHTML = `
      <div class="room">
        <div class="room-header">
          <button class="back-btn" id="backBtn">&larr; other frequencies</button>
        </div>

        <div class="freq-panel">
          <div class="freq-left">
            <div class="freq-code">${code}</div>
            <div class="freq-meta">
              <div class="freq-label">Frequency</div>
              <div class="signal-row">
                <div class="signal-bars offline" id="signalBars"><span></span><span></span><span></span><span></span></div>
                <div class="signal-text offline" id="signalText">CONNECTING</div>
              </div>
            </div>
          </div>
          <button class="copy-btn" id="copyBtn">Copy link</button>
        </div>

        <div class="dropzone" id="dropzone">
          <div class="dropzone-icon">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#8b9498" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v12 M7 8l5-5 5 5 M4 17v3h16v-3"/>
            </svg>
          </div>
          <div class="dropzone-text"><b>Drop files here</b> or click to browse</div>
          <div class="dropzone-sub" id="dropzoneSub">visible to anyone on ${code}</div>
          <input type="file" id="fileInput" multiple>
        </div>

        <div class="manifest-header">
          <div class="manifest-title">Transmissions</div>
          <div class="manifest-count" id="fileCount">0 files</div>
        </div>
        <div id="fileList"></div>
      </div>
    `;

    document.getElementById('backBtn').addEventListener('click', () => { location.hash = ''; });

    const copyBtn = document.getElementById('copyBtn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = 'Copy link'; copyBtn.classList.remove('copied'); }, 1600);
      } catch (e) {
        showToast('Could not copy — copy the address bar link instead', true);
      }
    });

    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
    dropzone.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

    connectSocket(code);
    loadFiles();

    serverConfigReady.then(() => {
      const subEl = document.getElementById('dropzoneSub');
      if (subEl) {
        const parts = [];
        if (serverConfig.maxFileMB) parts.push('up to ' + fmtMB(serverConfig.maxFileMB) + ' per file');
        if (serverConfig.fileTtlHours) parts.push('auto-deletes after ' + fmtDuration(serverConfig.fileTtlHours));
        parts.push('visible to anyone on ' + code);
        subEl.textContent = parts.join(' \u00b7 ');
      }
      renderFileList();
    });

    roomState.tickTimer = setInterval(renderFileList, 30000);
  }

  function setSignal(connected) {
    const bars = document.getElementById('signalBars');
    const text = document.getElementById('signalText');
    if (!bars) return;
    bars.classList.toggle('offline', !connected);
    text.classList.toggle('offline', !connected);
    text.textContent = connected ? 'LIVE' : 'CONNECTING';
  }

  function connectSocket(code) {
    socket = io(API_BASE || undefined, { transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      setSignal(true);
      socket.emit('join-room', code);
    });
    socket.on('disconnect', () => setSignal(false));
    socket.on('connect_error', () => setSignal(false));

    socket.on('files-added', (added) => {
      const isMine = added.every(f => roomState.uploading.some(u => u.name === f.name));
      roomState.uploading = roomState.uploading.filter(u => !added.some(f => f.name === u.name));
      roomState.files = roomState.files.concat(added.filter(f => !roomState.files.some(existing => existing.id === f.id)));
      renderFileList();
      if (!isMine) {
        showToast(added.length === 1 ? '"' + added[0].name + '" just landed' : added.length + ' new files just landed');
      }
    });

    socket.on('file-removed', ({ id }) => {
      roomState.files = roomState.files.filter(f => f.id !== id);
      renderFileList();
    });
  }

  async function loadFiles() {
    try {
      const res = await fetch(API_BASE + '/api/rooms/' + roomState.code + '/files');
      const data = await res.json();
      roomState.files = data.files || [];
      renderFileList();
    } catch (e) {
      showToast('Could not reach the server', true);
    }
  }

  function renderFileList() {
    const listEl = document.getElementById('fileList');
    const countEl = document.getElementById('fileCount');
    if (!listEl) return;

    const files = roomState.files.slice().sort((a, b) => b.uploadedAt - a.uploadedAt);
    countEl.textContent = files.length + (files.length === 1 ? ' file' : ' files');

    const uploadingHtml = roomState.uploading.map(u => `
      <div class="upload-row" data-temp="${u.tempId}">
        <div class="file-icon">${iconFor(u.type)}</div>
        <div class="file-info">
          <div class="file-name">${escapeHtml(u.name)}</div>
          <div class="upload-bar"><div class="upload-bar-fill" style="width:${u.progress}%"></div></div>
        </div>
      </div>
    `).join('');

    if (!files.length && !roomState.uploading.length) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="ping"></div>
          No transmissions yet.<br>Drop a file to broadcast on ${roomState.code}.
        </div>`;
      return;
    }

    const filesHtml = files.map(f => `
      <div class="file-row">
        <div class="file-icon">${iconFor(f.type)}</div>
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.name)}</div>
          <div class="file-meta">${fmtSize(f.size)} &middot; ${fmtTime(f.uploadedAt)}${fmtExpiresIn(f.uploadedAt) ? ' &middot; ' + fmtExpiresIn(f.uploadedAt) : ''}</div>
        </div>
        <div class="file-actions">
          <a class="file-dl" href="${API_BASE}/api/rooms/${roomState.code}/files/${f.id}/download" title="Download">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 4v12 M6 11l6 6 6-6 M5 20h14"/>
            </svg>
          </a>
          <button class="file-rm" data-id="${f.id}" title="Remove">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 7h14 M9 7V5h6v2 M7 7l1 13h8l1-13"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    listEl.innerHTML = uploadingHtml + filesHtml;

    listEl.querySelectorAll('.file-rm').forEach(btn => {
      btn.addEventListener('click', () => removeFile(btn.dataset.id));
    });
  }

  async function removeFile(id) {
    try {
      const res = await fetch(API_BASE + '/api/rooms/' + roomState.code + '/files/' + id, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed');
      roomState.files = roomState.files.filter(f => f.id !== id);
      renderFileList();
    } catch (e) {
      showToast('Could not remove that file', true);
    }
  }

  function handleFiles(fileListArg) {
    let files = Array.from(fileListArg);
    if (!files.length) return;

    if (serverConfig.maxFileMB) {
      const maxBytes = serverConfig.maxFileMB * 1024 * 1024;
      const tooBig = files.filter(f => f.size > maxBytes);
      files = files.filter(f => f.size <= maxBytes);
      tooBig.forEach(f => showToast('"' + f.name + '" is over the ' + fmtMB(serverConfig.maxFileMB) + ' limit', true));
      if (!files.length) return;
    }

    const formData = new FormData();
    files.forEach(f => formData.append('files', f, f.name));

    const tempEntries = files.map(f => ({ tempId: Math.random().toString(36).slice(2), name: f.name, type: f.type, progress: 0 }));
    roomState.uploading.push(...tempEntries);
    renderFileList();

    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE + '/api/rooms/' + roomState.code + '/upload');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      tempEntries.forEach(t => t.progress = pct);
      renderFileList();
    };
    xhr.onload = () => {
      roomState.uploading = roomState.uploading.filter(u => !tempEntries.includes(u));
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText);
        roomState.files = roomState.files.concat(
          (data.files || []).filter(f => !roomState.files.some(existing => existing.id === f.id))
        );
        renderFileList();
        showToast(files.length === 1 ? '"' + files[0].name + '" is on the air' : files.length + ' files are on the air');
      } else {
        renderFileList();
        try {
          const err = JSON.parse(xhr.responseText);
          showToast(err.error || 'Upload failed', true);
        } catch (e) {
          showToast('Upload failed', true);
        }
      }
    };
    xhr.onerror = () => {
      roomState.uploading = roomState.uploading.filter(u => !tempEntries.includes(u));
      renderFileList();
      showToast('Upload failed — check the server is reachable', true);
    };
    xhr.send(formData);
  }
})();
