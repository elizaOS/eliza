import express from 'express';
import cors from 'cors';
import { FirecrawlService } from './firecrawl-service';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firecrawl Service
let firecrawlService: FirecrawlService;

async function initializeServices() {
    try {
        firecrawlService = new FirecrawlService();
        console.log('✅ Firecrawl service initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize services:', error);
        process.exit(1);
    }
}

// Serve static HTML interface
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Firecrawl ENS Market Analysis Agent</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 30px;
        }
        .chat-container {
            border: 1px solid #ddd;
            border-radius: 8px;
            height: 400px;
            overflow-y: auto;
            padding: 20px;
            margin-bottom: 20px;
            background-color: #fafafa;
        }
        .message {
            margin-bottom: 15px;
            padding: 10px;
            border-radius: 8px;
        }
        .user-message {
            background-color: #007bff;
            color: white;
            margin-left: 20%;
        }
        .agent-message {
            background-color: #e9ecef;
            color: #333;
            margin-right: 20%;
        }
        .input-container {
            display: flex;
            gap: 10px;
        }
        input[type="text"] {
            flex: 1;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 16px;
        }
        button {
            padding: 12px 24px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
        }
        button:hover {
            background-color: #0056b3;
        }
        button:disabled {
            background-color: #6c757d;
            cursor: not-allowed;
        }
        .status {
            text-align: center;
            margin-top: 20px;
            padding: 10px;
            border-radius: 6px;
        }
        .status.success {
            background-color: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        .status.error {
            background-color: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        .quick-actions {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .quick-action {
            padding: 8px 16px;
            background-color: #6c757d;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .quick-action:hover {
            background-color: #545b62;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔥 Firecrawl ENS Market Analysis Agent</h1>
        
        <div class="quick-actions">
            <button class="quick-action" onclick="sendMessage('Hello, what can you do?')">What can you do?</button>
            <button class="quick-action" onclick="sendMessage('Crawl Vision.io')">Crawl Vision.io</button>
            <button class="quick-action" onclick="sendMessage('Analyze deals')">Analyze Deals</button>
        </div>
        
        <div id="chat-container" class="chat-container"></div>
        
        <div class="input-container">
            <input type="text" id="message-input" placeholder="Ask me to crawl Vision.io or analyze deals..." onkeypress="handleKeyPress(event)">
            <button onclick="sendMessage()" id="send-button">Send</button>
        </div>
        
        <div id="status" class="status" style="display: none;"></div>
    </div>

    <script>
        const chatContainer = document.getElementById('chat-container');
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        const statusDiv = document.getElementById('status');

        function addMessage(message, isUser = false) {
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${isUser ? 'user-message' : 'agent-message'}\`;
            messageDiv.textContent = message;
            chatContainer.appendChild(messageDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function showStatus(message, isError = false) {
            statusDiv.textContent = message;
            statusDiv.className = \`status \${isError ? 'error' : 'success'}\`;
            statusDiv.style.display = 'block';
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 5000);
        }

        function handleKeyPress(event) {
            if (event.key === 'Enter') {
                sendMessage();
            }
        }

        async function sendMessage(customMessage = null) {
            const message = customMessage || messageInput.value.trim();
            if (!message) return;

            // Add user message to chat
            addMessage(message, true);
            
            // Clear input
            if (!customMessage) {
                messageInput.value = '';
            }

            // Disable send button
            sendButton.disabled = true;
            sendButton.textContent = 'Sending...';

            try {
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ message }),
                });

                const data = await response.json();

                if (data.success) {
                    addMessage(data.response);
                } else {
                    addMessage('Sorry, I encountered an error: ' + data.error);
                    showStatus('Error: ' + data.error, true);
                }
            } catch (error) {
                addMessage('Sorry, I encountered an error: ' + error.message);
                showStatus('Error: ' + error.message, true);
            } finally {
                // Re-enable send button
                sendButton.disabled = false;
                sendButton.textContent = 'Send';
            }
        }

        // Add welcome message
        addMessage('Hello! I am a Firecrawl agent specialized in ENS domain market analysis. I can help you crawl Vision.io for domain listings and analyze deals. Try asking me to "crawl Vision.io" or "analyze deals".');
    </script>
</body>
</html>
    `);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        agent: 'Firecrawl ENS Market Analysis Agent'
    });
});

// Crawl Vision.io for new listings
app.post('/api/crawl-vision', async (req, res) => {
    try {
        if (!firecrawlService) {
            return res.status(500).json({ error: 'Firecrawl service not available' });
        }

        const result = await firecrawlService.crawlVisionListings();
        res.json({ success: true, result });
    } catch (error: any) {
        console.error('Error crawling Vision.io:', error);
        res.status(500).json({ error: error.message });
    }
});

// Direct Firecrawl endpoint for testing
app.post('/api/firecrawl', async (req, res) => {
    try {
        if (!firecrawlService) {
            return res.status(500).json({ error: 'Firecrawl service not available' });
        }

        const result = await firecrawlService.crawlVisionListings();
        res.json(result);
    } catch (error: any) {
        console.error('Error in direct Firecrawl:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get deals below floor price
app.get('/api/deals', async (req, res) => {
    try {
        if (!firecrawlService) {
            return res.status(500).json({ error: 'Firecrawl service not available' });
        }

        const deals = await firecrawlService.getDealsBelowFloor();
        res.json({ success: true, deals });
    } catch (error: any) {
        console.error('Error getting deals:', error);
        res.status(500).json({ error: error.message });
    }
});

// Simple chat endpoint for the agent
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // Simple response logic based on the message
        let response = '';

        if (message.toLowerCase().includes('crawl') || message.toLowerCase().includes('vision')) {
            if (!firecrawlService) {
                response = 'Sorry, the Firecrawl service is not available right now.';
            } else {
                const result = await firecrawlService.crawlVisionListings();
                response = `✅ ${result.message}`;
            }
        } else if (message.toLowerCase().includes('deal') || message.toLowerCase().includes('analyze')) {
            if (!firecrawlService) {
                response = 'Sorry, the Firecrawl service is not available right now.';
            } else {
                const deals = await firecrawlService.getDealsBelowFloor();
                if (deals.length === 0) {
                    response = 'No deals below floor price found in the database. Try running a crawl first to populate the database.';
                } else {
                    response = `Found ${deals.length} deals below floor price.`;
                }
            }
        } else {
            response = 'Hello! I am a Firecrawl agent specialized in ENS domain market analysis. I can help you crawl Vision.io for domain listings and analyze deals. Try asking me to "crawl Vision.io" or "analyze deals".';
        }

        res.json({
            success: true,
            response,
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        console.error('Error in chat:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start server
async function startServer() {
    await initializeServices();

    app.listen(PORT, () => {
        console.log(`🚀 Firecrawl ENS Market Analysis Agent running on port ${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
        console.log(`🌐 Chat endpoint: http://localhost:${PORT}/api/chat`);
        console.log(`🔍 Crawl endpoint: http://localhost:${PORT}/api/crawl-vision`);
    });
}

startServer().catch(console.error);
