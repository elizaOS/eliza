# Browser-Only MessageBus Example

## Simple HTML + JavaScript Chat

```html
<!DOCTYPE html>
<html>
  <head>
    <title>Eliza Browser Chat</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        max-width: 600px;
        margin: 50px auto;
      }
      #messages {
        border: 1px solid #ccc;
        height: 400px;
        overflow-y: auto;
        padding: 10px;
        margin-bottom: 10px;
      }
      .message {
        margin: 10px 0;
        padding: 8px;
        border-radius: 4px;
      }
      .user {
        background: #e3f2fd;
        text-align: right;
      }
      .agent {
        background: #f3e5f5;
        text-align: left;
      }
      input {
        width: 80%;
        padding: 8px;
      }
      button {
        padding: 8px 20px;
      }
    </style>
  </head>
  <body>
    <h1>Chat with Eliza</h1>
    <div id="messages"></div>
    <input id="input" type="text" placeholder="Type a message..." />
    <button onclick="sendMessage()">Send</button>

    <script type="module">
      import { MessageBusCore } from '@elizaos/core';

      // Create browser-only message bus (no server needed!)
      const messageBus = new MessageBusCore();

      const channelId = 'local-chat-123';
      const serverId = 'browser-local';
      const userId = 'user-' + Math.random().toString(36).slice(2);

      // Optional: Add localStorage persistence
      messageBus.use({
        name: 'local-storage',
        async onMessage(message) {
          const key = `chat:${message.channelId}`;
          const history = JSON.parse(localStorage.getItem(key) || '[]');
          history.push(message);
          // Keep last 100 messages
          if (history.length > 100) history.shift();
          localStorage.setItem(key, JSON.stringify(history));
        },
      });

      // Optional: Add a simple agent that auto-responds
      messageBus.use({
        name: 'simple-agent',
        async onMessage(message) {
          // Don't respond to our own messages
          if (message.authorId.startsWith('agent-')) return;

          // Simple response logic
          setTimeout(async () => {
            const responses = [
              "That's interesting! Tell me more.",
              'I understand. How does that make you feel?',
              'Fascinating. What happened next?',
              'I see. Why do you think that is?',
            ];

            await messageBus.send({
              channelId: message.channelId,
              serverId: message.serverId,
              authorId: 'agent-eliza',
              authorName: 'Eliza',
              content: responses[Math.floor(Math.random() * responses.length)],
            });
          }, 1000); // Delay to simulate thinking
        },
      });

      // Subscribe to messages and update UI
      messageBus.subscribe(channelId, (message) => {
        displayMessage(message);
      });

      // Load chat history from localStorage
      function loadHistory() {
        const key = `chat:${channelId}`;
        const history = JSON.parse(localStorage.getItem(key) || '[]');
        history.forEach((msg) => displayMessage(msg));
      }

      // Display a message in the UI
      function displayMessage(message) {
        const messagesDiv = document.getElementById('messages');
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${message.authorId === userId ? 'user' : 'agent'}`;
        msgDiv.innerHTML = `
        <strong>${message.authorName}:</strong><br/>
        ${message.content}<br/>
        <small>${new Date(message.timestamp).toLocaleTimeString()}</small>
      `;
        messagesDiv.appendChild(msgDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      }

      // Send a message
      window.sendMessage = async function () {
        const input = document.getElementById('input');
        const text = input.value.trim();
        if (!text) return;

        await messageBus.send({
          channelId: channelId,
          serverId: serverId,
          authorId: userId,
          authorName: 'You',
          content: text,
        });

        input.value = '';
      };

      // Handle Enter key
      document.getElementById('input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
      });

      // Load previous messages
      loadHistory();
    </script>
  </body>
</html>
```

## React Example

```tsx
import { MessageBusCore, type Message } from '@elizaos/core';
import { useState, useEffect, useRef } from 'react';

export function BrowserChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const busRef = useRef<MessageBusCore | null>(null);
  const channelId = 'react-chat-123';
  const userId = 'user-' + Math.random().toString(36).slice(2);

  useEffect(() => {
    // Create message bus once
    const bus = new MessageBusCore();
    busRef.current = bus;

    // Add simple agent
    bus.use({
      name: 'agent',
      async onMessage(message) {
        if (message.authorId.startsWith('agent-')) return;

        setTimeout(() => {
          bus.send({
            channelId: message.channelId,
            serverId: 'browser',
            authorId: 'agent-eliza',
            authorName: 'Eliza',
            content: `You said: "${message.content}". That's interesting!`,
          });
        }, 500);
      },
    });

    // Subscribe to messages
    const unsubscribe = bus.subscribe(channelId, (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    return () => unsubscribe();
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || !busRef.current) return;

    await busRef.current.send({
      channelId: channelId,
      serverId: 'browser',
      authorId: userId,
      authorName: 'You',
      content: input,
    });

    setInput('');
  };

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className={msg.authorId === userId ? 'user' : 'agent'}>
            <strong>{msg.authorName}:</strong> {msg.content}
          </div>
        ))}
      </div>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
        placeholder="Type a message..."
      />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
}
```

## Adding Server Connection (Optional Upgrade)

```typescript
// Start with browser-only
const messageBus = new MessageBusCore();

// Later, connect to server if available
if (window.location.hostname !== 'localhost') {
  const socket = io('https://your-server.com');

  // Add server adapter
  messageBus.use({
    name: 'server-sync',
    async onMessage(message) {
      // Send to server
      socket.emit('message', message);
    },
  });

  // Receive from server
  socket.on('messageBroadcast', (data) => {
    // Server messages are already broadcasted locally by MessageBusCore
    // No need to do anything here unless you want to validate
  });
}
```

## Key Benefits

✅ **No server required** - works completely offline  
✅ **Progressive enhancement** - add server later if needed  
✅ **Same API everywhere** - browser, Node.js, Bun, Deno  
✅ **Extensible** - add any adapter (DB, API, LLM, etc)  
✅ **Type-safe** - full TypeScript support

## What's Happening Under the Hood

```typescript
// 1. User sends message
await messageBus.send({ content: 'Hello!' });

// 2. MessageBusCore:
//    - Generates ID and timestamp
//    - Calls all registered adapters (localStorage, agent, etc)
//    - Emits to all subscribers
//    - Returns the complete message

// 3. UI subscriber receives message and updates display

// 4. Agent adapter receives message and generates response

// 5. Agent response goes through same flow (step 1-3)
```

**That's it! Pure JavaScript, no complex setup, works in any browser.**
