# 🔌 Client Packages

## Overview

Eliza's client packages enable integration with various platforms and services. Each client provides a standardized interface for sending and receiving messages, handling media, and interacting with platform-specific features.

### Architecture Overview

```mermaid
graph TD
    RT["Agent Runtime"]
    CI["Client Interface"]
    RT --> CI

    %% Main Clients
    CI --> DC["Direct Client"]
    CI --> DSC["Discord Client"]
    CI --> TC["Telegram Client"]
    CI --> TWC["Twitter Client"]
    CI --> AC["Auto Client"]
    CI --> DEVA["Deva Client"]

    %% Key Features - one per client for clarity
    DC --> |"REST API"| DC1["Messages & Images"]
    DSC --> |"Bot Integration"| DSC1["Voice & Messages"]
    TC --> |"Bot API"| TC1["Commands & Media"]
    TWC --> |"Social"| TWC1["Posts & Interactions"]
    AC --> |"Trading"| AC1["Analysis & Execution"]
    DEVA --> |"Social"| DEVA1["Messages & Execution"]

    %% Simple styling with better contrast and black text
    classDef default fill:#f9f9f9,stroke:#333,stroke-width:1px,color:black
    classDef highlight fill:#e9e9e9,stroke:#333,stroke-width:2px,color:black

    class RT,CI highlight
```

## Available Clients

-   **Discord** (`@elizaos/client-discord`) - Full Discord bot integration
-   **Twitter** (`@elizaos/client-twitter`) - Twitter bot and interaction handling
-   **Telegram** (`@elizaos/client-telegram`) - Telegram bot integration
-   **Direct** (`@elizaos/client-direct`) - Direct API for custom integrations
-   **Auto** (`@elizaos/client-auto`) - Automated trading and interaction client
-   **Alexa skill** (`@elizaos/client-alexa`) - Alexa skill API integration
-   **Deva** (`@elizaos/client-deva`) - Client for integrating with Deva.me

---

## Installation

```bash
# Discord
pnpm add @elizaos/client-discord

# Twitter
pnpm add @elizaos/client-twitter

# Telegram
pnpm add @elizaos/client-telegram

# Direct API
pnpm add @elizaos/client-direct

# Auto Client
pnpm add @elizaos/client-auto

# Deva Client
pnpm add @elizaos/client-deva
```

---

## Discord Client

The Discord client provides full integration with Discord's features including voice, reactions, and attachments.

### Basic Setup

```typescript
import { DiscordClientInterface } from "@elizaos/client-discord";

// Initialize client
const client = await DiscordClientInterface.start(runtime);

// Configuration in .env
DISCORD_APPLICATION_ID = your_app_id;
DISCORD_API_TOKEN = your_bot_token;
```

### Features

-   Voice channel integration
-   Message attachments
-   Reactions handling
-   Media transcription
-   Room management

### Voice Integration

```typescript
class VoiceManager {
    // Join a voice channel
    async handleJoinChannelCommand(interaction) {
        await this.joinVoiceChannel(channel);
    }

    // Handle voice state updates
    async handleVoiceStateUpdate(oldState, newState) {
        if (newState.channelId) {
            await this.handleUserJoinedChannel(newState);
        }
    }
}
```

### Message Handling

```typescript
class MessageManager {
    async handleMessage(message) {
        // Ignore bot messages
        if (message.author.bot) return;

        // Process attachments
        if (message.attachments.size > 0) {
            await this.processAttachments(message);
        }

        // Generate response
        await this.generateResponse(message);
    }
}
```

## Twitter Client

The Twitter client enables posting, searching, and interacting with Twitter users.

### Basic Setup

```typescript
import { TwitterClientInterface } from "@elizaos/client-twitter";
// Initialize client
const client = await TwitterClientInterface.start(runtime);

// Configuration in .env
TWITTER_USERNAME = your_username;
TWITTER_PASSWORD = your_password;
TWITTER_EMAIL = your_email;
```

### Components

-   **PostClient**: Handles creating and managing posts
-   **SearchClient**: Handles search functionality
-   **InteractionClient**: Manages user interactions

### Post Management

```typescript
class TwitterPostClient {
    async createPost(content: string) {
        return await this.post({
            text: content,
            media: await this.processMedia(),
        });
    }

    async replyTo(tweetId: string, content: string) {
        return await this.post({
            text: content,
            reply: { in_reply_to_tweet_id: tweetId },
        });
    }
}
```

### Search Features

```typescript
class TwitterSearchClient {
    async searchTweets(query: string) {
        return await this.search({
            query,
            filters: {
                recency: "recent",
                language: "en",
            },
        });
    }
}
```

## Telegram Client

The Telegram client provides messaging and bot functionality for Telegram.

### Basic Setup

```typescript
import { TelegramClientInterface } from "@elizaos/client-telegram";

// Initialize client
const client = await TelegramClientInterface.start(runtime);

// Configuration in .env
TELEGRAM_BOT_TOKEN = your_bot_token;
```

### Message Management

```typescript
class TelegramClient {
    async handleMessage(message) {
        // Process message content
        const content = await this.processMessage(message);

        // Generate response
        const response = await this.generateResponse(content);

        // Send response
        await this.sendMessage(message.chat.id, response);
    }
}
```

## Direct Client

The Direct client provides a REST API interface for custom integrations.

### Basic Setup

```typescript
import { DirectClientInterface } from "@elizaos/client-direct";

// Initialize client
const client = await DirectClientInterface.start(runtime);
```

### API Endpoints

```typescript
class DirectClient {
    constructor() {
        // Message endpoint
        this.app.post("/:agentId/message", async (req, res) => {
            const response = await this.handleMessage(req.body);
            res.json(response);
        });

        // Image generation endpoint
        this.app.post("/:agentId/image", async (req, res) => {
            const images = await this.generateImage(req.body);
            res.json(images);
        });
    }
}
```

## Auto Client

The Auto client enables automated interactions and trading.

### Basic Setup

```typescript
import { AutoClientInterface } from "@elizaos/client-auto";

// Initialize client
const client = await AutoClientInterface.start(runtime);
```

### Automated Trading

```typescript
class AutoClient {
    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;

        // Start trading loop
        this.interval = setInterval(() => {
            this.makeTrades();
        }, 60 * 60 * 1000); // 1 hour interval
    }

    async makeTrades() {
        // Get recommendations
        const recommendations = await this.getHighTrustRecommendations();

        // Analyze tokens
        const analysis = await this.analyzeTokens(recommendations);

        // Execute trades
        await this.executeTrades(analysis);
    }
}
```

## Alexa Client

The Alexa client provides API integration with alexa skill.

### Basic Setup

```typescript
import { AlexaClientInterface } from "@elizaos/client-alexa";

// Initialize client
const client = await AlexaClientInterface.start(runtime);

// Configuration in .env
ALEXA_SKILL_ID= your_alexa_skill_id
ALEXA_CLIENT_ID= your_alexa_client_id #Alexa developer console permissions tab
ALEXA_CLIENT_SECRET= your_alexa_client_secret #Alexa developer console permissions tab
```

## Deva Client

The Deva client allows fetching user-related data and making posts based on it.

### Client setup

```typescript
export const DevaClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        await validateDevaConfig(runtime);

        const deva = new DevaClient(
            runtime,
            runtime.getSetting("DEVA_API_KEY"),
            runtime.getSetting("DEVA_API_BASE_URL"),
        );

        await deva.start();

        elizaLogger.success(
            `✅ Deva client successfully started for character ${runtime.character.name}`,
        );

        return deva;
    },
};
```

### Fetch personal user data

```typescript
public async getMe(): Promise<DevaPersona | null> {
    return await fetch(`${this.apiBaseUrl}/persona`, {
		    headers: { ...this.defaultHeaders },
    })
        .then((res) => res.json())
        .catch(() => null);
}
```

### Fetch user posts

```typescript
public async getPersonaPosts(personaId: string): Promise<DevaPost[]> {
	  const res = await fetch(
		    `${this.apiBaseUrl}/post?filter_persona_id=${personaId}`, 
        {
			      headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
        },
    })
        .then((res) => res.json());
	  
	  return res.items;
}
```

### Create and publish a post on behalf of the user

```typescript
public async makePost({ text, in_reply_to_id }: { text: string; in_reply_to_id: string }): Promise<DevaPost> {
    const res = await fetch(`${this.apiBaseUrl}/post`, {
		    method: "POST", 
        headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ text, in_reply_to_id, author_type: "BOT" }),
    }).then((res) => res.json());

    return res;
```

## Common Features

### Message Handling

All clients implement standard message handling:

```typescript
interface ClientInterface {
    handleMessage(message: Message): Promise<void>;
    generateResponse(context: Context): Promise<Response>;
    sendMessage(destination: string, content: Content): Promise<void>;
}
```

### Media Processing

```typescript
interface MediaProcessor {
    processImage(image: Image): Promise<ProcessedImage>;
    processVideo(video: Video): Promise<ProcessedVideo>;
    processAudio(audio: Audio): Promise<ProcessedAudio>;
}
```

### Error Handling

```typescript
class BaseClient {
    protected async handleError(error: Error) {
        console.error("Client error:", error);

        if (error.code === "RATE_LIMIT") {
            await this.handleRateLimit(error);
        } else if (error.code === "AUTH_FAILED") {
            await this.refreshAuth();
        }
    }
}
```

---

## Best Practices

1. **Authentication**

    - Store credentials securely in environment variables
    - Implement token refresh mechanisms
    - Handle authentication errors gracefully

2. **Rate Limiting**

    - Implement exponential backoff
    - Track API usage
    - Queue messages during rate limits

3. **Error Handling**

    - Log errors with context
    - Implement retry logic
    - Handle platform-specific errors

4. **Media Processing**
    - Validate media before processing
    - Handle different file formats
    - Implement size limits

### Error Handling

```typescript
class BaseClient {
    protected async handleError(error: Error) {
        if (error.code === "RATE_LIMIT") {
            await this.handleRateLimit(error);
        } else if (error.code === "AUTH_FAILED") {
            await this.refreshAuth();
        } else if (error.code === "NETWORK_ERROR") {
            await this.reconnect();
        }

        // Log error
        console.error("Client error:", {
            type: error.name,
            message: error.message,
            code: error.code,
            stack: error.stack,
        });
    }
}
```

### Resource Management

```typescript
class ClientManager {
    private async cleanup() {
        // Close connections
        await Promise.all(this.connections.map((conn) => conn.close()));

        // Clear caches
        this.cache.clear();

        // Cancel timers
        this.timers.forEach((timer) => clearInterval(timer));
    }

    private async reconnect() {
        await this.cleanup();
        await wait(this.calculateBackoff());
        await this.initialize();
    }
}
```

### Rate Limiting

```typescript
class RateLimiter {
    private async handleRateLimit(error: RateLimitError) {
        const delay = this.calculateBackoff(error);
        await wait(delay);
        return this.retryRequest();
    }

    private calculateBackoff(error: RateLimitError): number {
        return Math.min(
            this.baseDelay * Math.pow(2, this.attempts),
            this.maxDelay
        );
    }
}
```

---

## Performance Optimization

### Connection Management

```typescript
class ClientManager {
    private reconnect() {
        await this.disconnect();
        await wait(this.backoff());
        await this.connect();
    }
}
```

### Message Queuing

```typescript
class MessageQueue {
    async queueMessage(message: Message) {
        await this.queue.push(message);
        this.processQueue();
    }
}
```

## Troubleshooting

### Common Issues

1. **Authentication Failures**

```typescript
// Implement token refresh
async refreshAuth() {
	const newToken = await this.requestNewToken();
	await this.updateToken(newToken);
}
```

2. **Rate Limits**

```typescript
// Handle rate limiting
async handleRateLimit(error) {
	const delay = this.calculateBackoff(error);
	await wait(delay);
	return this.retryRequest();
}
```

3. **Connection Issues**

```typescript
// Implement reconnection logic
async handleDisconnect() {
	await this.reconnect({
		maxAttempts: 5,
		backoff: "exponential",
	});
}
```

4. **Message Processing Failure**

```typescript
async processMessage(message) {
	try {
		return await this.messageProcessor(message);
	} catch (error) {
		if (error.code === "INVALID_FORMAT") {
			return this.handleInvalidFormat(message);
		}
		throw error;
	}
}
```

## Related Resources

-   [Error Handling](../../packages/core)
