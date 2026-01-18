// elizaOS ICP Chat App
// ICP Agent setup
import { Actor, HttpAgent } from 'https://esm.sh/@dfinity/agent@2.2.0';
import { Principal } from 'https://esm.sh/@dfinity/principal@1.0.0';

// Canister interface
const idlFactory = ({ IDL }) => {
  const CharacterConfig = IDL.Record({
    name: IDL.Text,
    bio: IDL.Text,
    system: IDL.Opt(IDL.Text),
    personality_traits: IDL.Vec(IDL.Text),
    knowledge_base: IDL.Vec(IDL.Text),
  });
  
  const CanisterError = IDL.Variant({
    NotInitialized: IDL.Null,
    AlreadyInitialized: IDL.Null,
    InvalidInput: IDL.Text,
    HttpOutcallError: IDL.Text,
    VetKeyError: IDL.Text,
    Unauthorized: IDL.Null,
    SerializationError: IDL.Text,
    InternalError: IDL.Text,
  });
  
  const ChatRequest = IDL.Record({
    message: IDL.Text,
    user_id: IDL.Opt(IDL.Text),
    room_id: IDL.Opt(IDL.Text),
  });
  
  const ChatResponse = IDL.Record({
    message: IDL.Text,
    room_id: IDL.Text,
    message_id: IDL.Text,
    timestamp: IDL.Nat64,
  });
  
  const AgentState = IDL.Record({
    agent_id: IDL.Text,
    character: CharacterConfig,
    initialized: IDL.Bool,
    created_at: IDL.Nat64,
    last_active: IDL.Nat64,
    message_count: IDL.Nat64,
  });
  
  const HealthStatus = IDL.Record({
    status: IDL.Text,
    agent_id: IDL.Opt(IDL.Text),
    agent_name: IDL.Opt(IDL.Text),
    initialized: IDL.Bool,
    message_count: IDL.Nat64,
    memory_count: IDL.Nat64,
    uptime_ns: IDL.Nat64,
  });
  
  const InferenceMode = IDL.Variant({
    ElizaClassic: IDL.Null,
    OpenAI: IDL.Null,
    OnChainLLM: IDL.Null,
    DfinityLLM: IDL.Null,
  });
  
  const InferenceStatus = IDL.Record({
    current_mode: InferenceMode,
    eliza_classic_ready: IDL.Bool,
    openai_configured: IDL.Bool,
    onchain_llm_configured: IDL.Bool,
    onchain_llm_canister_id: IDL.Opt(IDL.Text),
    onchain_llm_model: IDL.Opt(IDL.Text),
    dfinity_llm_enabled: IDL.Bool,
    dfinity_llm_model: IDL.Opt(IDL.Text),
  });
  
  return IDL.Service({
    init_agent: IDL.Func([IDL.Opt(CharacterConfig)], [IDL.Variant({ Ok: IDL.Text, Err: CanisterError })], []),
    chat: IDL.Func([ChatRequest], [IDL.Variant({ Ok: ChatResponse, Err: CanisterError })], []),
    get_agent_state: IDL.Func([], [IDL.Opt(AgentState)], ['query']),
    health: IDL.Func([], [HealthStatus], ['query']),
    is_openai_ready: IDL.Func([], [IDL.Bool], ['query']),
    get_inference_status: IDL.Func([], [InferenceStatus], ['query']),
    set_inference_mode: IDL.Func([InferenceMode], [IDL.Variant({ Ok: IDL.Null, Err: CanisterError })], []),
    get_eliza_greeting: IDL.Func([], [IDL.Text], ['query']),
    eliza_classic_chat: IDL.Func([IDL.Text], [IDL.Text], ['query']),
  });
};

// State
let actor = null;
let isInitialized = false;
let isLoading = false;
let roomId = null;
let agentName = 'Eliza';
let inferenceMode = 'ElizaClassic';
let inferenceStatus = null;
let messageCounter = 0; // Unique counter to prevent ID collisions

// DOM elements
const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const chatForm = document.getElementById('chat-form');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const errorBanner = document.getElementById('error-banner');
const errorText = document.getElementById('error-text');

// Mode switcher elements
const modeClassicBtn = document.getElementById('mode-classic');
const modeOpenAIBtn = document.getElementById('mode-openai');
const modeOnChainBtn = document.getElementById('mode-onchain');
const modeDfinityBtn = document.getElementById('mode-dfinity');
const modeNote = document.getElementById('mode-note');
const modeButtons = [modeClassicBtn, modeOpenAIBtn, modeOnChainBtn, modeDfinityBtn];

// Backend canister ID - hardcoded for this deployment
// Note: canisterId in URL is for frontend asset routing, NOT the backend
const BACKEND_CANISTER_ID = 'uxrrr-q7777-77774-qaaaq-cai';

// Get backend canister ID from URL param or use default
function getCanisterId() {
  const urlParams = new URLSearchParams(window.location.search);
  // Only use explicit backendId param, ignore canisterId (that's for frontend routing)
  const backendId = urlParams.get('backendId');
  if (backendId) return backendId;
  // Default backend canister for local development
  return BACKEND_CANISTER_ID;
}

// Get host from current location or URL params
function getHost() {
  const urlParams = new URLSearchParams(window.location.search);
  const hostParam = urlParams.get('host');
  if (hostParam) return hostParam;
  
  // Use current origin if on localhost
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return `http://${window.location.host}`;
  }
  
  // For .localhost subdomain format
  if (window.location.hostname.endsWith('.localhost')) {
    return `http://localhost:${window.location.port || 4943}`;
  }
  
  // Production: use IC gateway
  return 'https://ic0.app';
}

function isLocalHost(host) {
  return host.includes('127.0.0.1') || host.includes('localhost');
}

// Initialize the ICP agent
async function initAgent() {
  try {
    const canisterId = getCanisterId();
    const host = getHost();
    
    statusText.textContent = 'Connecting to ICP...';
    console.log('Connecting to:', host, 'canister:', canisterId);
    
    const agent = HttpAgent.createSync({ host });
    
    // Fetch root key for local development
    if (host.includes('127.0.0.1') || host.includes('localhost')) {
      await agent.fetchRootKey();
    }
    
    actor = Actor.createActor(idlFactory, {
      agent,
      canisterId,
    });
    
    // Check health
    const health = await actor.health();
    console.log('Health:', health);
    
    if (!health.initialized) {
      statusText.textContent = 'Initializing agent...';
      
      // Initialize with default character
      const result = await actor.init_agent([]);
      
      if ('Err' in result) {
        throw new Error(Object.values(result.Err)[0] || 'Init failed');
      }
    }
    
    // Get agent state
    const state = await actor.get_agent_state();
    if (state && state.length > 0) {
      agentName = state[0].character.name;
    }
    
    // Get inference status
    try {
      inferenceStatus = await actor.get_inference_status();
      // Extract the mode variant name
      if (inferenceStatus.current_mode.DfinityLLM !== undefined) {
        inferenceMode = 'DfinityLLM';
      } else if (inferenceStatus.current_mode.OpenAI !== undefined) {
        inferenceMode = 'OpenAI';
      } else if (inferenceStatus.current_mode.OnChainLLM !== undefined) {
        inferenceMode = 'OnChainLLM';
      } else {
        inferenceMode = 'ElizaClassic';
      }
    } catch (e) {
      inferenceMode = 'ElizaClassic';
    }
    
    // Get greeting
    const greeting = await actor.get_eliza_greeting();
    
    isInitialized = true;
    statusDot.className = 'status-dot online';
    
    // Update mode switcher buttons
    updateModeSwitcher();
    
    // Update status text
    updateStatusText();

    // If on local replica, mark DFINITY as mainnet-only
    if (isLocalHost(host)) {
      if (modeNote) modeNote.hidden = false;
      if (modeDfinityBtn) {
        modeDfinityBtn.classList.add('local-only');
        modeDfinityBtn.title = 'DFINITY LLM is available on mainnet only';
      }
    }
    messageInput.placeholder = 'Send a message...';
    messageInput.disabled = false;
    sendButton.disabled = false;
    
    // Add welcome message based on mode
    let welcomeMsg;
    if (inferenceMode === 'DfinityLLM') {
      const model = inferenceStatus?.dfinity_llm_model?.[0] || 'Llama 3.1 8B';
      welcomeMsg = `Hello! I'm ${agentName}, powered by ${model} on the DFINITY LLM canister. This is FREE and managed by DFINITY. How can I help you?`;
    } else if (inferenceMode === 'OpenAI') {
      welcomeMsg = `Hello! I'm ${agentName}, powered by GPT-4o running on the Internet Computer. How can I help you today?`;
    } else if (inferenceMode === 'OnChainLLM') {
      const model = inferenceStatus?.onchain_llm_model?.[0] || 'Qwen';
      welcomeMsg = `Hello! I'm ${agentName}, powered by ${model} running fully on-chain on the Internet Computer. Ask me anything!`;
    } else {
      welcomeMsg = greeting;
    }
    addMessage('assistant', welcomeMsg);
    
    messageInput.focus();
    
  } catch (err) {
    console.error('Init error:', err);
    showError(`Failed to connect: ${err.message}`);
    statusText.textContent = 'Disconnected';
  }
}

// Add message to UI
function addMessage(role, content, id = null) {
  // Use unique counter + timestamp + random to guarantee unique IDs
  messageCounter++;
  const messageId = id || `msg-${messageCounter}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  // Escape HTML in content to prevent XSS
  const escapedContent = content ? escapeHtml(content) : '';
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;
  messageDiv.id = messageId;
  messageDiv.dataset.role = role; // Store role for debugging
  
  messageDiv.innerHTML = `
    <div class="message-avatar">${role === 'assistant' ? '🤖' : '👤'}</div>
    <div class="message-content">
      <div class="message-meta">
        <span class="message-role">${role === 'assistant' ? agentName : 'You'}</span>
        <span class="message-time">${timestamp}</span>
      </div>
      <div class="message-text">${escapedContent || '<span class="typing-indicator"><span>●</span><span>●</span><span>●</span></span>'}</div>
    </div>
  `;
  
  messagesContainer.appendChild(messageDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  
  console.log(`[addMessage] role=${role}, id=${messageId}, content preview: ${content?.substring(0, 50) || '(typing)'}`);
  
  return messageId;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Update message content
function updateMessage(id, content) {
  const messageDiv = document.getElementById(id);
  if (messageDiv) {
    const textDiv = messageDiv.querySelector('.message-text');
    if (textDiv) {
      const role = messageDiv.dataset.role;
      console.log(`[updateMessage] Updating ${role} message ${id} with: "${content?.substring(0, 50)}..."`);
      textDiv.textContent = content;
    } else {
      console.error(`[updateMessage] Could not find .message-text in element ${id}`);
    }
  } else {
    console.error(`[updateMessage] Could not find element with id ${id}`);
  }
}

// Show error
function showError(message) {
  errorText.textContent = message;
  errorBanner.classList.add('show');
}

// Hide error
function hideError() {
  errorBanner.classList.remove('show');
}

// Setup error close button
document.getElementById('error-close-btn').addEventListener('click', hideError);

// Update mode switcher UI based on inference status
function updateModeSwitcher() {
  // Reset all buttons
  modeButtons.forEach(btn => {
    if (btn) {
      btn.classList.remove('active', 'switching');
      btn.disabled = true;
    }
  });

  // Enable buttons based on what's available
  if (inferenceStatus) {
    if (modeClassicBtn) modeClassicBtn.disabled = !inferenceStatus.eliza_classic_ready;
    if (modeOpenAIBtn) modeOpenAIBtn.disabled = !inferenceStatus.openai_configured;
    if (modeOnChainBtn) modeOnChainBtn.disabled = !inferenceStatus.onchain_llm_configured;
    if (modeDfinityBtn) {
      const host = getHost();
      const local = isLocalHost(host);
      // DFINITY LLM is mainnet-only; disable on local replicas
      modeDfinityBtn.disabled = local || !inferenceStatus.dfinity_llm_enabled;
      if (local) {
        modeDfinityBtn.classList.add('local-only');
      }
    }

    // Show model name on on-chain button
    if (modeOnChainBtn && inferenceStatus.onchain_llm_model?.[0]) {
      modeOnChainBtn.textContent = inferenceStatus.onchain_llm_model[0];
    }
    
    // Show model name on DFINITY button
    if (modeDfinityBtn && inferenceStatus.dfinity_llm_model?.[0]) {
      modeDfinityBtn.textContent = inferenceStatus.dfinity_llm_model[0];
    }
  }

  // Highlight active mode
  const modeMap = {
    'ElizaClassic': modeClassicBtn,
    'OpenAI': modeOpenAIBtn,
    'OnChainLLM': modeOnChainBtn,
    'DfinityLLM': modeDfinityBtn,
  };
  const activeBtn = modeMap[inferenceMode];
  if (activeBtn) {
    activeBtn.classList.add('active');
  }
}

// Switch inference mode
async function switchMode(newMode) {
  if (isLoading || !actor || inferenceMode === newMode) return;
  if (newMode === 'DfinityLLM') {
    const host = getHost();
    if (isLocalHost(host)) {
      showError('DFINITY LLM is available on mainnet only.');
      return;
    }
  }

  // Find the button and show switching state
  const modeMap = {
    'ElizaClassic': modeClassicBtn,
    'OpenAI': modeOpenAIBtn,
    'OnChainLLM': modeOnChainBtn,
    'DfinityLLM': modeDfinityBtn,
  };
  const targetBtn = modeMap[newMode];

  try {
    // Disable all buttons during switch
    modeButtons.forEach(btn => {
      if (btn) {
        btn.disabled = true;
        btn.classList.remove('active');
      }
    });
    if (targetBtn) targetBtn.classList.add('switching');
    statusText.textContent = `Switching to ${newMode}...`;

    // Build the mode variant for Candid
    let modeVariant;
    if (newMode === 'ElizaClassic') {
      modeVariant = { ElizaClassic: null };
    } else if (newMode === 'OpenAI') {
      modeVariant = { OpenAI: null };
    } else if (newMode === 'OnChainLLM') {
      modeVariant = { OnChainLLM: null };
    } else if (newMode === 'DfinityLLM') {
      modeVariant = { DfinityLLM: null };
    }
    
    const result = await actor.set_inference_mode(modeVariant);
    
    if ('Err' in result) {
      throw new Error(Object.values(result.Err)[0] || 'Failed to switch mode');
    }
    
    // Update local state
    inferenceMode = newMode;
    
    // Refresh inference status
    inferenceStatus = await actor.get_inference_status();
    
    // Update UI
    updateModeSwitcher();
    updateStatusText();
    
    // Add system message about mode change
    const modeNames = {
      'ElizaClassic': 'ELIZA Classic (pattern matching)',
      'OpenAI': 'GPT-4o (OpenAI)',
      'OnChainLLM': `On-Chain LLM (${inferenceStatus?.onchain_llm_model?.[0] || 'local model'})`,
      'DfinityLLM': `DFINITY LLM (${inferenceStatus?.dfinity_llm_model?.[0] || 'Llama 3.1 8B'}) - FREE!`,
    };
    addMessage('assistant', `Switched to ${modeNames[newMode]}. How can I help you?`);
    
  } catch (err) {
    console.error('Mode switch error:', err);
    showError(`Failed to switch mode: ${err.message}`);
    // Revert UI
    updateModeSwitcher();
    updateStatusText();
  }
}

// Update status text based on current mode
function updateStatusText() {
  const modeBadges = {
    'ElizaClassic': '(Classic)',
    'OpenAI': '(GPT-4o)',
    'OnChainLLM': `(On-Chain${inferenceStatus?.onchain_llm_model?.[0] ? ` ${inferenceStatus.onchain_llm_model[0]}` : ''})`,
    'DfinityLLM': `(DFINITY${inferenceStatus?.dfinity_llm_model?.[0] ? ` ${inferenceStatus.dfinity_llm_model[0]}` : ' Llama 3.1'})`
  };
  const modelBadge = modeBadges[inferenceMode] || '(Classic)';
  statusText.textContent = `${agentName} Online ${modelBadge}`;
}

// Setup mode switcher event listeners
modeClassicBtn.addEventListener('click', () => switchMode('ElizaClassic'));
modeOpenAIBtn.addEventListener('click', () => switchMode('OpenAI'));
modeOnChainBtn.addEventListener('click', () => switchMode('OnChainLLM'));
if (modeDfinityBtn) modeDfinityBtn.addEventListener('click', () => switchMode('DfinityLLM'));

// Handle form submit
async function handleSubmit(e) {
  e.preventDefault();
  
  // Capture the user input IMMEDIATELY and clear the input field
  const userText = messageInput.value.trim();
  if (!userText || isLoading || !isInitialized) return;
  
  // Clear input immediately to prevent any issues
  messageInput.value = '';
  
  isLoading = true;
  messageInput.disabled = true;
  sendButton.disabled = true;
  sendButton.innerHTML = '<span class="spinner"></span>';
  
  // Log for debugging
  console.log(`[handleSubmit] User sent: "${userText}"`);
  
  // Add user message with the captured text
  const userMsgId = addMessage('user', userText);
  console.log(`[handleSubmit] User message added with id: ${userMsgId}`);
  
  // Add typing indicator for assistant - use a clearly different ID
  const assistantMsgId = addMessage('assistant', '');
  console.log(`[handleSubmit] Assistant placeholder added with id: ${assistantMsgId}`);
  
  try {
    // Call canister
    const request = {
      message: userText,
      user_id: [],
      room_id: roomId ? [roomId] : [],
    };
    
    console.log(`[handleSubmit] Calling chat with:`, request);
    const result = await actor.chat(request);
    console.log(`[handleSubmit] Got result:`, result);
    
    if ('Ok' in result) {
      const response = result.Ok;
      roomId = response.room_id;
      console.log(`[handleSubmit] Updating assistant message ${assistantMsgId} with: "${response.message.substring(0, 50)}..."`);
      updateMessage(assistantMsgId, response.message);
    } else {
      const errorMsg = Object.values(result.Err)[0] || 'Unknown error';
      updateMessage(assistantMsgId, `Error: ${errorMsg}`);
      showError(errorMsg);
    }
    
  } catch (err) {
    console.error('Chat error:', err);
    updateMessage(assistantMsgId, 'Sorry, something went wrong.');
    showError(err.message);
  }
  
  isLoading = false;
  messageInput.disabled = false;
  sendButton.disabled = false;
  sendButton.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  `;
  messageInput.focus();
}

// Setup event listeners
chatForm.addEventListener('submit', handleSubmit);

// Handle Enter key
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

// Initialize on load
initAgent();
