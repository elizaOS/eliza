# @elizaos/react

Headless React hooks for ElizaOS. Build custom UIs for ElizaOS agents with React and TypeScript.

## Features

- **Headless**: No UI coupling - use with any component library or design system
- **Type-safe**: Full TypeScript support with types from `@elizaos/api-client` and `@elizaos/core`
- **React Query powered**: Built on TanStack React Query for caching, refetching, and optimistic updates
- **Network-aware**: Smart polling that adapts to network conditions
- **Modular**: Import only the hooks you need

## Installation

```bash
bun add @elizaos/react @elizaos/api-client @elizaos/core @tanstack/react-query
```

### Peer Dependencies

- `react` >= 18.0.0
- `@tanstack/react-query` ^5.0.0
- `@elizaos/api-client` (workspace)
- `@elizaos/core` (workspace)

## Quick Start

### 1. Wrap your app with providers

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ElizaReactProvider } from '@elizaos/react';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ElizaReactProvider baseUrl="http://localhost:3000">
        <YourApp />
      </ElizaReactProvider>
    </QueryClientProvider>
  );
}
```

### 2. Use hooks in your components

```tsx
import { useAgents, useStartAgent } from '@elizaos/react';

function AgentList() {
  const { data: agents, isLoading } = useAgents();
  const startAgent = useStartAgent({
    onSuccess: (data) => {
      console.log('Agent started:', data);
    },
  });

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      {agents?.map((agent) => (
        <div key={agent.id}>
          <h3>{agent.name}</h3>
          <button onClick={() => startAgent.mutate(agent.id)}>
            Start Agent
          </button>
        </div>
      ))}
    </div>
  );
}
```

## API Reference

### Provider

#### `ElizaReactProvider`

Context provider that supplies an `ElizaClient` instance to all hooks.

**Props:**

```tsx
interface ElizaReactProviderProps {
  children: React.ReactNode;
  
  // Option 1: Provide a pre-configured client
  client?: ElizaClient;
  
  // Option 2: Provide configuration to create a client
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  headers?: Record<string, string>;
}
```

**Examples:**

```tsx
// With configuration
<ElizaReactProvider baseUrl="http://localhost:3000" apiKey="secret">
  <App />
</ElizaReactProvider>

// With pre-configured client
const client = new ElizaClient({ baseUrl: 'http://localhost:3000' });
<ElizaReactProvider client={client}>
  <App />
</ElizaReactProvider>
```

### Hooks

#### Agent Hooks

- `useAgents(options?)` - List all agents
- `useAgent(agentId, options?)` - Get a specific agent
- `useStartAgent(options?)` - Start an agent (mutation)
- `useStopAgent(options?)` - Stop an agent (mutation)
- `useAgentActions(agentId, roomId?, options?)` - Get agent actions/logs
- `useDeleteLog(options?)` - Delete an agent log (mutation)
- `useAgentPanels(agentId, options?)` - Get agent panels (public routes)
- `useAgentsWithDetails()` - Get all agents with detailed information

#### Run Hooks

- `useAgentRuns(agentId, params?, options?)` - List agent runs
- `useAgentRunDetail(agentId, runId, roomId?, options?)` - Get detailed run information

#### Messaging Hooks

- `useServers(options?)` - List all servers
- `useChannels(serverId, options?)` - List channels for a server
- `useChannelDetails(channelId, options?)` - Get channel details
- `useChannelParticipants(channelId, options?)` - Get channel participants
- `useDeleteChannel(options?)` - Delete a channel (mutation)

#### Message Hooks

- `useChannelMessages(channelId, initialServerId?)` - Get channel messages with pagination
- `useDeleteChannelMessage(options?)` - Delete a message (mutation)
- `useClearChannelMessages(options?)` - Clear all channel messages (mutation)

#### Memory Hooks

- `useAgentMemories(agentId, tableName?, channelId?, includeEmbedding?, options?)` - Get agent memories
- `useDeleteMemory(options?)` - Delete a memory (mutation)
- `useDeleteAllMemories(options?)` - Delete all memories in a room (mutation)
- `useUpdateMemory(options?)` - Update a memory (mutation)
- `useDeleteGroupMemory(options?)` - Delete a group memory (mutation)
- `useClearGroupChat(options?)` - Clear a group chat (mutation)

#### Internal Hooks (Agent-Perspective)

- `useAgentInternalActions(agentId, roomId?, options?)` - Get internal agent actions
- `useDeleteAgentInternalLog(options?)` - Delete internal agent log (mutation)
- `useAgentInternalMemories(agentId, roomId, tableName?, includeEmbedding?, options?)` - Get internal memories
- `useDeleteAgentInternalMemory(options?)` - Delete internal memory (mutation)
- `useDeleteAllAgentInternalMemories(options?)` - Delete all internal memories (mutation)
- `useUpdateAgentInternalMemory(options?)` - Update internal memory (mutation)

### Constants

```tsx
import { STALE_TIMES } from '@elizaos/react';

// Available stale time constants
STALE_TIMES.FREQUENT    // 30 seconds
STALE_TIMES.STANDARD    // 2 minutes
STALE_TIMES.RARE        // 10 minutes
STALE_TIMES.NEVER       // Infinity
```

## Advanced Usage

### Custom mutation callbacks

All mutation hooks accept `onSuccess`, `onError`, and `onMutate` callbacks:

```tsx
const startAgent = useStartAgent({
  onSuccess: (data, agentId) => {
    toast.success(`Agent ${agentId} started successfully`);
  },
  onError: (error) => {
    toast.error(`Failed to start agent: ${error.message}`);
  },
});
```

### Message state management

The `useChannelMessages` hook provides stateful message management:

```tsx
const {
  data: messages,
  isLoading,
  fetchNextPage,
  hasNextPage,
  addMessage,
  updateMessage,
  removeMessage,
  clearMessages,
} = useChannelMessages(channelId);

// Add a message (e.g., from WebSocket)
addMessage(newMessage);

// Update a message
updateMessage(messageId, { content: 'Updated content' });

// Remove a message
removeMessage(messageId);
```

### Network-aware polling

Hooks automatically adjust polling frequency based on network conditions:

- **Good connection (3G/4G)**: Standard polling intervals
- **Slow connection (2G/slow-2G)**: Reduced polling frequency
- **Offline**: Polling disabled

### Custom query options

All query hooks accept standard React Query options:

```tsx
const { data: agents } = useAgents({
  refetchInterval: 5000, // Custom refetch interval
  staleTime: 10000,
  enabled: someCondition,
});
```

## Migration from `packages/client`

If you're migrating from the old `packages/client` hooks:

1. Replace imports: `import { useAgents } from '@/hooks/use-query-hooks'` → `import { useAgents } from '@elizaos/react'`
2. Move UI logic (toasts, navigation) to component callbacks
3. Update mutation usage to use `onSuccess`/`onError` callbacks

**Before:**

```tsx
const startAgent = useStartAgent(); // Toast handled inside hook
startAgent.mutate(agentId);
```

**After:**

```tsx
const { toast } = useToast(); // Your UI toast hook
const startAgent = useStartAgent({
  onSuccess: () => toast({ title: 'Agent started' }),
  onError: (error) => toast({ title: 'Error', description: error.message }),
});
startAgent.mutate(agentId);
```

## License

MIT

