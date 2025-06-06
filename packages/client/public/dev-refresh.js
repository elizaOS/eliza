// Development auto-refresh script
// This script connects to the dev server WebSocket and refreshes the page when files change

(function() {
  // Only run in development
  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return;
  }

  let ws;
  let reconnectInterval = 2000;
  let reconnectTimeout;

  function connect() {
    try {
      ws = new WebSocket('ws://localhost:3001');
      
      ws.onopen = function() {
        console.log('[DEV] Auto-refresh connected');
        // Reset reconnect interval on successful connection
        reconnectInterval = 2000;
      };
      
      ws.onmessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'refresh') {
            console.log('[DEV] Files changed, refreshing page...');
            window.location.reload();
          }
        } catch (e) {
          console.error('[DEV] Error parsing message:', e);
        }
      };
      
      ws.onclose = function() {
        console.log('[DEV] Auto-refresh disconnected, attempting to reconnect...');
        // Attempt to reconnect with exponential backoff
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
          reconnectInterval = Math.min(reconnectInterval * 1.5, 10000);
          connect();
        }, reconnectInterval);
      };
      
      ws.onerror = function(error) {
        console.log('[DEV] Auto-refresh connection error:', error);
      };
      
    } catch (error) {
      console.log('[DEV] Failed to connect to auto-refresh server:', error);
      // Retry connection after a delay
      clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(connect, reconnectInterval);
    }
  }

  // Start connection
  connect();

  // Clean up on page unload
  window.addEventListener('beforeunload', function() {
    if (ws) {
      ws.close();
    }
    clearTimeout(reconnectTimeout);
  });
})(); 