// QuantumExplorer Browser UI

let sessionId = null;

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const logsEl = document.getElementById('logs');

// Add message to chat
function addMessage(text, isUser = false) {
  const div = document.createElement('div');
  div.className = `message ${isUser ? 'user' : 'agent'}`;
  const pre = document.createElement('pre');
  pre.textContent = text;
  div.appendChild(pre);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Add log entry
function addLog(text) {
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logsEl.insertBefore(div, logsEl.firstChild);
}

// Send message to agent
async function sendMessage(message) {
  if (!message.trim()) return;
  
  addMessage(message, true);
  inputEl.value = '';
  sendBtn.disabled = true;
  addLog(`Sent: ${message.substring(0, 50)}...`);
  
  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
    });
    
    const data = await response.json();
    sessionId = data.sessionId;
    addMessage(data.response);
    addLog('Received response');
  } catch (error) {
    addMessage('Error: ' + error.message);
    addLog('Error: ' + error.message);
  } finally {
    sendBtn.disabled = false;
  }
}

// Quick explore topic
async function exploreTopic(topic) {
  const message = `I'm curious about ${topic}. Please navigate to a physics education website and explore this concept. Extract the key information and explain what you learn in simple terms.`;
  await sendMessage(message);
}

// Check autonomy status
async function checkAutonomyStatus() {
  try {
    const response = await fetch('/autonomy/status');
    const data = await response.json();
    if (data.success) {
      const status = data.data.status;
      statusEl.textContent = status === 'active' ? 'Exploring...' : 'Idle';
      statusEl.className = `status-badge ${status === 'active' ? 'active' : 'idle'}`;
    }
  } catch (error) {
    console.error('Status check failed:', error);
  }
}

// Enable autonomy
async function enableAutonomy() {
  try {
    addLog('Enabling autonomy...');
    const response = await fetch('/autonomy/enable', { method: 'POST' });
    const data = await response.json();
    if (data.success) {
      addLog('Autonomy enabled - agent will explore independently');
      addMessage('🤖 Autonomous mode enabled! I will now explore quantum physics topics on my own. Check the activity log for updates.');
    }
    checkAutonomyStatus();
  } catch (error) {
    addLog('Failed to enable autonomy: ' + error.message);
  }
}

// Disable autonomy
async function disableAutonomy() {
  try {
    addLog('Disabling autonomy...');
    const response = await fetch('/autonomy/disable', { method: 'POST' });
    const data = await response.json();
    if (data.success) {
      addLog('Autonomy disabled');
      addMessage('🛑 Autonomous mode disabled. I await your instructions.');
    }
    checkAutonomyStatus();
  } catch (error) {
    addLog('Failed to disable autonomy: ' + error.message);
  }
}

// Fetch autonomy logs
async function fetchAutonomyLogs() {
  try {
    const response = await fetch('/autonomy/logs');
    const data = await response.json();
    if (data.success && data.data.items.length > 0) {
      // Show recent autonomy activity
      const recent = data.data.items.slice(-5);
      recent.forEach(item => {
        if (item.text && !logsEl.querySelector(`[data-id="${item.id}"]`)) {
          const div = document.createElement('div');
          div.className = 'log-entry';
          div.dataset.id = item.id;
          div.textContent = item.text.substring(0, 100);
          logsEl.insertBefore(div, logsEl.firstChild);
        }
      });
    }
  } catch (error) {
    // Silent fail for background polling
  }
}

// Event listeners
sendBtn.addEventListener('click', () => sendMessage(inputEl.value));
inputEl.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage(inputEl.value);
});

document.querySelectorAll('.topic-btn').forEach(btn => {
  btn.addEventListener('click', () => exploreTopic(btn.dataset.topic));
});

document.getElementById('enable-autonomy').addEventListener('click', enableAutonomy);
document.getElementById('disable-autonomy').addEventListener('click', disableAutonomy);

// Initial status check and polling
checkAutonomyStatus();
setInterval(checkAutonomyStatus, 5000);
setInterval(fetchAutonomyLogs, 10000);

// Health check
fetch('/health').then(r => r.json()).then(data => {
  addLog(`Agent ready: ${data.agent || 'QuantumExplorer'}`);
}).catch(err => {
  addLog('Health check failed: ' + err.message);
});
