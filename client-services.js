(() => {
  const APPROVAL_WAIT_MS = 10 * 60 * 1000;
  const APPROVAL_POLL_MS = 3000;
  const CHAT_POLL_MS = 4000;
  let pendingApproval = null;
  let lastApprovalSubject = null;
  let csrfToken = '';
  let chatPollTimer = null;
  let chatCursor = 0;
  let chatBusy = false;
  let chatRendered = new Set();

  const byId = id => document.getElementById(id);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const userFacingError = (value, fallback) => {
    const message = String(value?.message ?? value ?? '').trim();
    return message && /[\u1000-\u109F]/.test(message) ? message : fallback;
  };

  async function apiJson(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const pathname = new URL(url, location.href).pathname;
    if (csrfToken && options.method === 'POST' && ['/api/chat/messages', '/api/session/logout'].includes(pathname)) {
      headers['X-ULTRA-CSRF'] = csrfToken;
    }
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        credentials: options.credentials || 'same-origin',
        cache: 'no-store',
        signal: options.signal || AbortSignal.timeout(12000)
      });
    } catch {
      throw new Error('ဆာဗာနှင့် ချိတ်ဆက်၍မရပါ။ အင်တာနက်ချိတ်ဆက်မှုကို စစ်ဆေးပြီး ထပ်ကြိုးစားပါ။');
    }
    let payload = {};
    try { payload = await response.json(); } catch { /* Non-JSON error response. */ }
    if (!response.ok) {
      const error = new Error(userFacingError(payload.error, 'ဆာဗာမှ တောင်းဆိုမှုကို မလုပ်ဆောင်နိုင်ပါ။'));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function showApprovalDialog(accountId, platform, state = 'pending', detail = '') {
    const uid = String(!accountId || accountId === 'N/A' ? 'မရရှိပါ' : accountId);
    const platformName = String(!platform || platform === 'N/A' ? 'မသတ်မှတ်ရသေးပါ' : platform);
    const title = byId('approval-title');
    const status = byId('approval-status-text');
    const hint = byId('approval-request-hint');
    const id = byId('approval-account-id');
    const platformEl = byId('approval-platform');
    const overlay = byId('approval-overlay');
    if (id) id.textContent = uid;
    if (platformEl) platformEl.textContent = platformName;
    if (!title || !status || !overlay) return;

    const states = {
      pending: {
        title: '❌ သင်၏ ID အား အတည်ပြုမထားရသေးပါ',
        color: '#fecaca',
        status: 'ℹ️ Admin အား ခွင့်ပြုချက်တောင်းပါ .',
        hint: 'ℹ️ ခွင့်ပြုချက်တောင်းရန် @kiki20251 သို့ ID ပို့ပေးပါ:'
      },
      approvedRetry: {
        title: '✅ ID အတည်ပြုပြီးပါပြီ',
        color: '#86efac',
        status: 'သင့် ID ကို ယခင်က အုပ်ချုပ်သူက အတည်ပြုပြီးဖြစ်သည်။ အကောင့်ဝင်ခြင်းကို ပြန်လုပ်ပါ။',
        hint: 'ယခု ID အတွက် Telegram ခွင့်ပြုချက် ထပ်မတောင်းတော့ပါ။'
      },
      rejected: {
        title: '❌ အုပ်ချုပ်သူက တောင်းဆိုမှုကို ပယ်ချလိုက်သည်',
        color: '#fecaca',
        status: 'ခွင့်ပြုချက် မရရှိသေးပါ။ အကောင့် ID နှင့် ပလက်ဖောင်းကို စစ်ဆေးပြီး ပြန်လည်ဝင်ရောက်ပါ။',
        hint: 'အုပ်ချုပ်သူက အတည်မပြုသေးသောကြောင့် ဂိမ်းထဲဝင်ခွင့် မရသေးပါ။'
      },
      timeout: {
        title: '⌛ အတည်ပြုချက် စောင့်ဆိုင်းချိန် ပြည့်သွားပါပြီ',
        color: '#fde68a',
        status: 'တောင်းဆိုမှုသည် စောင့်ဆိုင်းနေဆဲ ဖြစ်နိုင်ပါသည်။ အုပ်ချုပ်သူက ခွင့်ပြုပြီးနောက် ပြန်လည်ဝင်ရောက်ပါ။',
        hint: 'Telegram Bot သို့ ID တောင်းဆိုချက် ပို့ထားပါသည်။ အခြေအနေကို ပြန်စစ်ပါ သို့မဟုတ် အကောင့်ဝင်ခြင်းကို ပြန်စပါ။'
      },
      requestError: {
        title: '⚠️ Telegram Bot သို့ တောင်းဆိုချက် မပို့နိုင်ပါ',
        color: '#fde68a',
        status: detail || 'ဆာဗာ သို့မဟုတ် Telegram Bot နှင့် ချိတ်ဆက်မှုကို စစ်ဆေးပြီး ထပ်ကြိုးစားပါ။',
        hint: 'သင့် ID ကို ပြထားပါသည်။ စကားဝှက်နှင့် ပလက်ဖောင်း token ကို Telegram သို့ မပို့ထားပါ။'
      },
      accountError: {
        title: '⚠️ ပလက်ဖောင်းအကောင့် ID မရရှိပါ',
        color: '#fde68a',
        status: 'ပလက်ဖောင်းမှ အကောင့် ID အစစ်ကို ဖတ်မရပါ။ ပလက်ဖောင်း/API နှင့် အင်တာနက်ချိတ်ဆက်မှုကို စစ်ဆေးပြီး ပြန်လည်ဝင်ရောက်ပါ။',
        hint: 'ID ကို အတည်မပြုနိုင်သေးသောကြောင့် ဝင်ခွင့်မပေးထားပါ။'
      }
    };
    const chosen = states[state] || states.pending;
    title.textContent = chosen.title;
    title.style.color = chosen.color;
    status.textContent = detail || chosen.status;
    if (hint) hint.textContent = chosen.hint;
    overlay.style.display = 'flex';
  }

  function closeApprovalDialog() {
    const overlay = byId('approval-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function copyApprovalId() {
    const value = byId('approval-account-id')?.textContent || '';
    if (!value || value === 'N/A' || value === 'မရရှိပါ') return;
    try {
      await navigator.clipboard.writeText(value);
      if (typeof addLog === 'function') addLog('အကောင့် ID ကို ကူးယူပြီးပါပြီ: ' + escapeHtml(value), 'info');
    } catch {
      const field = document.createElement('textarea');
      field.value = value;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
  }

  function approvalQuery(subject, requestId) {
    const params = new URLSearchParams({
      platform: subject.platform,
      accountId: subject.accountId,
      requestId
    });
    return `/api/approval/status?${params.toString()}`;
  }

  function settleApproval(approved, state) {
    const current = pendingApproval;
    if (!current || current.settled) return;
    current.settled = true;
    clearInterval(current.interval);
    clearTimeout(current.timeout);
    pendingApproval = null;
    if (approved) {
      closeApprovalDialog();
    } else {
      showApprovalDialog(current.subject.accountId, current.subject.platform, state);
    }
    current.resolve(approved);
  }

  async function checkPendingApproval() {
    const current = pendingApproval;
    if (!current || current.checking || current.settled) return;
    current.checking = true;
    try {
      const result = await apiJson(approvalQuery(current.subject, current.requestId));
      if (result.status === 'approved') settleApproval(true, 'pending');
      else if (result.status === 'rejected') settleApproval(false, 'rejected');
    } catch {
      // Transient network errors are retried by the next poll or the manual refresh button.
    } finally {
      if (pendingApproval === current) current.checking = false;
    }
  }

  async function retryApprovalCheck() {
    if (pendingApproval) {
      await checkPendingApproval();
      return;
    }
    if (lastApprovalSubject) {
      if (!session.token) {
        showApprovalDialog(lastApprovalSubject.accountId, lastApprovalSubject.platform, 'approvedRetry', 'သင့် lottery ပလက်ဖောင်းအကောင့်သို့ ပြန်ဝင်ပြီး အကောင့်ဝင်ခြင်းကို ထပ်လုပ်ပါ။');
        return;
      }
      try {
        const result = await apiJson('/api/approval/check', {
          method: 'POST',
          body: JSON.stringify({ ...lastApprovalSubject, platformToken: session.token })
        });
        if (result.approved) {
          showApprovalDialog(lastApprovalSubject.accountId, lastApprovalSubject.platform, 'approvedRetry');
        }
      } catch { /* Keep the current status message. */ }
    }
  }

  function waitForApproval(subject, requestId) {
    return new Promise(resolve => {
      const current = {
        subject,
        requestId,
        resolve,
        checking: false,
        settled: false,
        interval: null,
        timeout: null
      };
      pendingApproval = current;
      current.interval = setInterval(checkPendingApproval, APPROVAL_POLL_MS);
      current.timeout = setTimeout(() => settleApproval(false, 'timeout'), APPROVAL_WAIT_MS);
      void checkPendingApproval();
    });
  }

  async function startServerSession(subject) {
    csrfToken = '';
    const result = await apiJson('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({ ...subject, platformToken: session.token })
    });
    if (!result.ok || typeof result.csrfToken !== 'string') throw new Error('ဆာဗာ session မရရှိပါ။ အကောင့်ဝင်ခြင်းကို ပြန်လုပ်ပါ။');
    csrfToken = result.csrfToken;
    return true;
  }

  async function requireApproval(platform, accountId) {
    const subject = { platform: String(platform), accountId: String(accountId) };
    lastApprovalSubject = subject;
    let result;
    try {
      result = await apiJson('/api/approval/request', {
        method: 'POST',
        body: JSON.stringify({ ...subject, platformToken: session.token })
      });
    } catch (error) {
      showApprovalDialog(accountId, platform, 'requestError', error.message);
      return false;
    }
    if (result.status === 'approved') {
      try { return await startServerSession(subject); }
      catch (error) {
        showApprovalDialog(accountId, platform, 'requestError', error.message);
        return false;
      }
    }
    if (result.status !== 'pending' || !/^[a-f0-9]{32}$/.test(result.requestId || '')) {
      showApprovalDialog(accountId, platform, 'requestError', 'ဆာဗာမှ အတည်ပြုတောင်းဆိုမှု ID မရရှိပါ။ အကောင့်ဝင်ခြင်းကို ပြန်လုပ်ပါ။');
      return false;
    }
    showApprovalDialog(accountId, platform, 'pending');
    const approved = await waitForApproval(subject, result.requestId);
    if (!approved) return false;
    try { return await startServerSession(subject); }
    catch (error) {
      showApprovalDialog(accountId, platform, 'requestError', error.message);
      return false;
    }
  }

  async function handleLogin() {
    const platform = byId('platform').value;
    const rawPhone = byId('phone').value;
    const phone = '95' + rawPhone.replace(/^0/, '');
    const pass = byId('password').value;
    const button = byId('login-button');
    let accountId = 'N/A';
    if (!rawPhone.trim() || !pass) {
      if (typeof addLog === 'function') addLog('ဖုန်းနံပါတ်နှင့် စကားဝှက် ထည့်ပါ။', 'lose');
      return;
    }
    if (button) { button.disabled = true; }
    session.platform = platform;
    session.token = '';
    try {
      const response = await callAPI('Login', {
        logintype: 'mobile',
        username: phone,
        pwd: pass,
        language: CONFIG[platform].lang
      });
      if (response.code !== 0 || !response.data?.token) {
        const loginError = userFacingError(response.msg, 'ဖုန်းနံပါတ် သို့မဟုတ် စကားဝှက် မမှန်ပါ။ ထည့်သွင်းမှုကို စစ်ဆေးပြီး ပြန်ကြိုးစားပါ။');
        if (typeof addLog === 'function') addLog('အမှား: ' + escapeHtml(loginError), 'lose');
        return;
      }
      session.token = response.data.token;
      const info = await updateBalance();
      accountId = String(info?.userId || '').trim();
      if (!accountId) {
        session.token = '';
        showApprovalDialog('N/A', platform, 'accountError');
        return;
      }
      byId('display-userid').textContent = accountId;
      const approved = await requireApproval(platform, accountId);
      if (!approved) {
        session.token = '';
        localStorage.removeItem('ultra_session');
        return;
      }
      localStorage.setItem('ultra_session', JSON.stringify({ phone: rawPhone, platform, token: session.token }));
      initUI();
      const balanceText = byId('display-bal').innerText.replace(/[^0-9.,]/g, '') || '0';
      if (typeof addLog === 'function') addLog(`
        <span style="color:#22c55e; font-size:15px; font-weight:bold;">🟢 အကောင့်ဝင်ခြင်း အောင်မြင်ပါသည်!</span><br><br>
        🔓 ဂိမ်းပလန်: <span style="color:#eab308;">အခမဲ့ကစားမုဒ်</span><br>
        🎮 ဂိမ်းအမည် : <span style="color:#c026d3;">🎰 ${platform}</span><br>
        👤 အသုံးပြုသူအကောင့် ID: <span style="color:#60a5fa; font-weight:bold;">${escapeHtml(accountId)}</span><br>
        💰 လက်ကျန်ငွေ ပမာဏ: <span style="color:#fbbf24; font-weight:bold;">${balanceText} ကျပ်</span>
      `, 'win');
    } catch (error) {
      console.error('Login/approval request failed:', error);
      session.token = '';
      localStorage.removeItem('ultra_session');
      const userError = userFacingError(error, 'အကောင့်ဝင်ခြင်း သို့မဟုတ် အတည်ပြုတောင်းဆိုမှု မအောင်မြင်ပါ။ အင်တာနက်ချိတ်ဆက်မှုကို စစ်ဆေးပြီး ထပ်ကြိုးစားပါ။');
      showApprovalDialog(accountId, platform, accountId === 'N/A' ? 'accountError' : 'requestError', userError);
      if (typeof addLog === 'function') addLog('အကောင့်ဝင်ခြင်း အမှား: ' + escapeHtml(userError), 'lose');
    } finally {
      if (button) { button.disabled = false; button.textContent = '🚀 အကောင့်ဝင်မည်'; }
    }
  }

  function clearChat(statusText = '') {
    const container = byId('chat-messages');
    if (!container) return;
    container.replaceChildren();
    if (statusText) {
      const status = document.createElement('div');
      status.textContent = statusText;
      status.style.cssText = 'text-align:center;color:#94a3b8;padding:24px 12px;';
      container.appendChild(status);
    }
  }

  function currentChatSubject() {
    return {
      platform: String(session.platform || ''),
      accountId: String(byId('display-userid')?.textContent || '').trim()
    };
  }

  function appendChatMessage(data) {
    const container = byId('chat-messages');
    if (!container || !data) return;
    const messageId = Number(data.id) || 0;
    if (messageId && chatRendered.has(messageId)) return;
    if (messageId) {
      chatRendered.add(messageId);
      chatCursor = Math.max(chatCursor, messageId);
    }
    const me = currentChatSubject();
    const isMe = data.username === me.accountId && data.platform === me.platform;
    const wrapper = document.createElement('div');
    wrapper.style.textAlign = isMe ? 'right' : 'left';
    wrapper.style.marginBottom = '10px';

    const inner = document.createElement('div');
    inner.style.display = 'inline-block';
    inner.style.maxWidth = '82%';
    const header = document.createElement('div');
    header.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:4px;padding:0 6px;';
    const who = document.createElement('strong');
    who.textContent = String(data.username || 'ကစားသမား');
    who.style.color = isMe ? '#22c55e' : '#60a5fa';
    header.textContent = `${String(data.time || '')} • `;
    header.appendChild(who);

    const bubble = document.createElement('div');
    bubble.textContent = String(data.message || '');
    bubble.style.cssText = `padding:13px 17px;border-radius:18px;border-top-${isMe ? 'right' : 'left'}-radius:5px;color:white;box-shadow:0 3px 10px rgba(0,0,0,.3);background:${isMe ? 'rgba(34,197,94,.35)' : 'rgba(255,255,255,.08)'};white-space:pre-wrap;overflow-wrap:anywhere;`;
    inner.append(header, bubble);
    wrapper.appendChild(inner);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  async function fetchChatMessages(after = 0) {
    const params = new URLSearchParams({ after: String(after) });
    return apiJson(`/api/chat/messages?${params.toString()}`);
  }

  async function loadRecentMessages() {
    if (chatBusy) return;
    chatBusy = true;
    chatCursor = 0;
    chatRendered = new Set();
    clearChat('စကားပြောခန်းစာများကို ဖွင့်နေပါသည်…');
    try {
      const result = await fetchChatMessages(0);
      clearChat();
      result.messages.forEach(appendChatMessage);
      if (!result.messages.length) clearChat('စကားပြောခန်းတွင် စာမရှိသေးပါ။');
    } catch (error) {
      clearChat(userFacingError(error, 'စကားပြောခန်းနှင့် ချိတ်ဆက်မရပါ။'));
    } finally {
      chatBusy = false;
    }
  }

  async function pollChatMessages() {
    if (chatBusy || byId('chat-panel')?.style.display === 'none') return;
    chatBusy = true;
    try {
      const result = await fetchChatMessages(chatCursor);
      result.messages.forEach(appendChatMessage);
    } catch { /* Retry on the next poll; do not disrupt betting UI. */ }
    finally { chatBusy = false; }
  }

  function openChatPanel() {
    const panel = byId('chat-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    void loadRecentMessages();
    if (!chatPollTimer) chatPollTimer = setInterval(pollChatMessages, CHAT_POLL_MS);
  }

  function closeChatPanel() {
    const panel = byId('chat-panel');
    if (panel) panel.style.display = 'none';
    if (chatPollTimer) clearInterval(chatPollTimer);
    chatPollTimer = null;
  }

  async function sendChatMessage() {
    const input = byId('chat-input');
    const text = String(input?.value || '').trim();
    if (!text) return;
    const button = document.querySelector('#chat-panel button[onclick="sendChatMessage()"]');
    if (button) button.disabled = true;
    try {
      const result = await apiJson('/api/chat/messages', {
        method: 'POST',
        body: JSON.stringify({ message: text })
      });
      input.value = '';
      appendChatMessage(result.message);
    } catch (error) {
      if (typeof addLog === 'function') addLog('စကားပြောခန်း အမှား: ' + escapeHtml(userFacingError(error, 'စကားပြောခန်းစာပို့မရပါ။')), 'lose');
    } finally {
      if (button) button.disabled = false;
      input?.focus();
    }
  }

  async function endUserServerSession() {
    try {
      await apiJson('/api/session/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch { /* Local logout must still complete if the network is unavailable. */ }
    csrfToken = '';
  }

  async function restoreSession() {
    const saved = localStorage.getItem('ultra_session');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        byId('phone').value = data.phone || '';
        byId('platform').value = data.platform || '777BIGWIN';
        if (data.token && CONFIG[data.platform]) {
          session.token = data.token;
          session.platform = data.platform;
          const info = await updateBalance();
          const accountId = String(info?.userId || '').trim();
          if (!accountId) {
            session.token = '';
            localStorage.removeItem('ultra_session');
            showApprovalDialog('N/A', data.platform, 'accountError');
          } else {
            const approved = await requireApproval(data.platform, accountId);
            if (approved) {
              byId('display-userid').textContent = accountId;
              initUI();
              localStorage.setItem('ultra_session', JSON.stringify({ phone: data.phone || '', platform: data.platform, token: session.token }));
            } else {
              session.token = '';
              localStorage.removeItem('ultra_session');
            }
          }
        }
      } catch (error) {
        console.error('Saved session restore failed:', error);
        localStorage.removeItem('ultra_session');
        session.token = '';
      }
    }
    startVisualTimer();
  }

  // ---- Broadcast dialog ----
  let lastBroadcastId = Number(localStorage.getItem('ultra_last_broadcast') || 0) || 0;
  let broadcastPollTimer = null;

  function showBroadcastDialog(message) {
    const overlay = byId('broadcast-overlay');
    const msgEl = byId('broadcast-message');
    if (!overlay || !msgEl) return;
    msgEl.textContent = message || '';
    overlay.style.display = 'flex';
  }

  function closeBroadcastDialog() {
    const overlay = byId('broadcast-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function pollBroadcasts() {
    try {
      const data = await apiJson(`/api/broadcasts?after=${lastBroadcastId}`);
      const list = data.broadcasts || [];
      for (const b of list) {
        if (b.id > lastBroadcastId) {
          lastBroadcastId = b.id;
          localStorage.setItem('ultra_last_broadcast', String(lastBroadcastId));
          showBroadcastDialog(b.message);
        }
      }
    } catch { /* retry next poll */ }
  }

  function startBroadcastPolling() {
    if (broadcastPollTimer) return;
    pollBroadcasts();
    broadcastPollTimer = setInterval(pollBroadcasts, 8000);
  }

  function stopBroadcastPolling() {
    if (broadcastPollTimer) {
      clearInterval(broadcastPollTimer);
      broadcastPollTimer = null;
    }
  }

  window.startBroadcastPolling = startBroadcastPolling;
  window.stopBroadcastPolling = stopBroadcastPolling;
  window.closeBroadcastDialog = closeBroadcastDialog;
  window.showBroadcastDialog = showBroadcastDialog;

  window.handleLogin = handleLogin;
  window.showApprovalDialog = showApprovalDialog;
  window.closeApprovalDialog = closeApprovalDialog;
  window.copyApprovalId = copyApprovalId;
  window.retryApprovalCheck = retryApprovalCheck;
  window.openChatPanel = openChatPanel;
  window.closeChatPanel = closeChatPanel;
  window.sendChatMessage = sendChatMessage;
  window.loadRecentMessages = loadRecentMessages;
  window.appendChatMessage = appendChatMessage;
  window.endUserServerSession = endUserServerSession;
  window.onload = restoreSession;
})();
