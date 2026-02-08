const WebSocket = require('ws');

const PORT = 17373;
const TIMEOUT_MS = 15000; // 15 seconds

console.log(`Starting WebSocket server on ws://127.0.0.1:${PORT}`);

const wss = new WebSocket.Server({ port: PORT });

let connected = false;
let messageReceived = false;

const timeout = setTimeout(() => {
  if (!connected) {
    console.error('❌ FAIL: Extension did not connect within timeout');
    console.error('This means the Chrome extension is not loaded or not working');
    process.exit(1);
  }
}, TIMEOUT_MS);

wss.on('connection', (ws) => {
  console.log('✅ SUCCESS: Extension connected to WebSocket bridge!');
  connected = true;
  clearTimeout(timeout);

  ws.on('message', (msg) => {
    const message = msg.toString();
    console.log('📨 Received from extension:', message);
    messageReceived = true;

    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'hello' && parsed.from === 'extension') {
        console.log('✅ Extension sent proper hello handshake');
      }
    } catch (e) {
      // Not JSON, that's fine
    }
  });

  // Send a ping to verify two-way communication
  console.log('📤 Sending ping to extension...');
  ws.send(JSON.stringify({ type: 'ping' }));

  // Wait a bit for response, then close
  setTimeout(() => {
    if (messageReceived) {
      console.log('✅ Two-way communication verified');
    } else {
      console.log('⚠️  Warning: No message received from extension');
    }

    ws.close();
    wss.close();

    console.log('✅ Extension bridge test completed successfully');
    process.exit(0);
  }, 3000);
});

wss.on('error', (err) => {
  console.error('❌ WebSocket server error:', err.message);
  process.exit(1);
});

console.log(`⏳ Waiting up to ${TIMEOUT_MS/1000}s for extension to connect...`);
console.log('💡 Make sure Chrome is open with the ComputerUse Bridge extension installed');
