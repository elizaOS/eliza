# 🤖 Agent Package

## Overview

The Agent Package (`@eliza/agent`) provides the high-level orchestration layer for Eliza, managing agent lifecycles, character loading, client initialization, and runtime coordination.

## Installation

```bash
bun add @eliza/agent
```

## Quick Start

```typescript
import { startAgents, loadCharacters } from "@eliza/agent";

// Start agents with default or custom characters
const args = parseArguments();
const characters = await loadCharacters(args.characters);

// Initialize agents
await startAgents();
```

## Core Components

### Agent Creation

```typescript
export async function createAgent(
    character: Character,
    db: IDatabaseAdapter,
    token: string,
): Promise<AgentRuntime> {
    return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        character,
        plugins: [
            bootstrapPlugin,
            nodePlugin,
            // Conditional plugins
            character.settings.secrets.WALLET_PUBLIC_KEY ? solanaPlugin : null,
        ].filter(Boolean),
        providers: [],
        actions: [],
        services: [],
        managers: [],
    });
}
```

### Character Loading

```typescript
export async function loadCharacters(
    charactersArg: string,
): Promise<Character[]> {
    // Parse character paths
    let characterPaths = charactersArg
        ?.split(",")
        .map((path) => path.trim())
        .map((path) => normalizePath(path));

    const loadedCharacters = [];

    // Load each character file
    for (const path of characterPaths) {
        try {
            const character = JSON.parse(fs.readFileSync(path, "utf8"));

            // Load plugins if specified
            if (character.plugins) {
                character.plugins = await loadPlugins(character.plugins);
            }

            loadedCharacters.push(character);
        } catch (error) {
            console.error(`Error loading character from ${path}: ${error}`);
        }
    }

    // Fall back to default character if none loaded
    if (loadedCharacters.length === 0) {
        loadedCharacters.push(defaultCharacter);
    }

    return loadedCharacters;
}
```

### Client Initialization

```typescript
export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime,
) {
    const clients = [];
    const clientTypes =
        character.clients?.map((str) => str.toLowerCase()) || [];

    if (clientTypes.includes(Clients.DISCORD)) {
        clients.push(await DiscordClientInterface.start(runtime));
    }
    if (clientTypes.includes(Clients.TELEGRAM)) {
        clients.push(await TelegramClientInterface.start(runtime));
    }
    if (clientTypes.includes(Clients.TWITTER)) {
        clients.push(await TwitterClientInterface.start(runtime));
    }
    if (clientTypes.includes(Clients.DIRECT)) {
        clients.push(await AutoClientInterface.start(runtime));
    }

    return clients;
}
```

## Database Management

```typescript
function initializeDatabase(): IDatabaseAdapter {
    // Use PostgreSQL if URL provided
    if (process.env.POSTGRES_URL) {
        return new PostgresDatabaseAdapter({
            connectionString: process.env.POSTGRES_URL,
        });
    }

    // Fall back to SQLite
    return new SqliteDatabaseAdapter(new Database("./elizadb.sqlite"));
}
```

## Token Management

```typescript
export function getTokenForProvider(
    provider: ModelProviderName,
    character: Character,
) {
    switch (provider) {
        case ModelProviderName.OPENAI:
            return (
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );

        case ModelProviderName.ANTHROPIC:
            return (
                character.settings?.secrets?.ANTHROPIC_API_KEY ||
                character.settings?.secrets?.CLAUDE_API_KEY ||
                settings.ANTHROPIC_API_KEY
            );

        // Handle other providers...
    }
}
```

## Agent Lifecycle Management

### Starting Agents

```typescript
async function startAgent(character: Character, directClient: any) {
    try {
        // Get provider token
        const token = getTokenForProvider(character.modelProvider, character);

        // Initialize database
        const db = initializeDatabase();

        // Create runtime
        const runtime = await createAgent(character, db, token);

        // Initialize clients
        const clients = await initializeClients(character, runtime);

        // Register with direct client
        directClient.registerAgent(runtime);

        return clients;
    } catch (error) {
        console.error(
            `Error starting agent for character ${character.name}:`,
            error,
        );
        throw error;
    }
}
```

### Shell Interface

```typescript
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

async function handleUserInput(input, agentId) {
    if (input.toLowerCase() === "exit") {
        rl.close();
        return;
    }

    try {
        const response = await fetch(
            `http://localhost:${serverPort}/${agentId}/message`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    text: input,
                    userId: "user",
                    userName: "User",
                }),
            },
        );

        const data = await response.json();
        data.forEach((message) => console.log(`Agent: ${message.text}`));
    } catch (error) {
        console.error("Error:", error);
    }
}
```

## Advanced Features

### Plugin Management

```typescript
async function loadPlugins(pluginPaths: string[]) {
    return await Promise.all(
        pluginPaths.map(async (plugin) => {
            const importedPlugin = await import(plugin);
            return importedPlugin;
        }),
    );
}
```

### Character Hot Reloading

```typescript
async function reloadCharacter(runtime: IAgentRuntime, characterPath: string) {
    // Load new character
    const character = JSON.parse(fs.readFileSync(characterPath, "utf8"));

    // Update runtime
    runtime.character = character;

    // Reload plugins
    if (character.plugins) {
        const plugins = await loadPlugins(character.plugins);
        runtime.registerPlugins(plugins);
    }
}
```

### Multi-Agent Coordination

```typescript
class AgentCoordinator {
    private agents: Map<string, IAgentRuntime>;

    async broadcast(message: Memory) {
        const responses = await Promise.all(
            Array.from(this.agents.values()).map((agent) =>
                agent.processMessage(message),
            ),
        );
        return responses;
    }

    async coordinate(agents: string[], task: Task) {
        // Coordinate multiple agents on a task
        const selectedAgents = agents.map((id) => this.agents.get(id));

        return await this.executeCoordinatedTask(selectedAgents, task);
    }
}
```

## Best Practices

### Character Management

```typescript
// Validate character before loading
function validateCharacter(character: Character) {
    if (!character.name) {
        throw new Error("Character must have a name");
    }

    if (!character.modelProvider) {
        throw new Error("Model provider must be specified");
    }
}

// Use character versioning
const character = {
    name: "Agent",
    version: "1.0.0",
    // ...
};
```

### Error Handling

```typescript
async function handleAgentError(error: Error, character: Character) {
    // Log error with context
    console.error(`Agent ${character.name} error:`, error);

    // Attempt recovery
    if (error.code === "TOKEN_EXPIRED") {
        await refreshToken(character);
    }

    // Notify monitoring
    await notify({
        level: "error",
        character: character.name,
        error,
    });
}
```

### Resource Management

```typescript
class ResourceManager {
    async cleanup() {
        // Close database connections
        await this.db.close();

        // Shutdown clients
        await Promise.all(this.clients.map((client) => client.stop()));

        // Clear caches
        this.cache.clear();
    }

    async monitor() {
        // Monitor resource usage
        const usage = process.memoryUsage();
        if (usage.heapUsed > threshold) {
            await this.cleanup();
        }
    }
}
```

## Troubleshooting

### Common Issues

1. **Character Loading Failures**

```typescript
try {
    await loadCharacters(charactersArg);
} catch (error) {
    if (error.code === "ENOENT") {
        console.error("Character file not found");
    } else if (error instanceof SyntaxError) {
        console.error("Invalid character JSON");
    }
}
```

2. **Client Initialization Errors**

```typescript
async function handleClientError(error: Error) {
    if (error.message.includes("rate limit")) {
        await wait(exponentialBackoff());
    } else if (error.message.includes("auth")) {
        await refreshAuth();
    }
}
```

3. **Database Connection Issues**

```typescript
async function handleDbError(error: Error) {
    if (error.message.includes("connection")) {
        await reconnectDb();
    } else if (error.message.includes("locked")) {
        await waitForLock();
    }
}
```

## Related Resources

- [Character Creation Guide](#)
- [Client Configuration](#)
- [Plugin Development](#)
- [Multi-Agent Setup](../packages/agents)
