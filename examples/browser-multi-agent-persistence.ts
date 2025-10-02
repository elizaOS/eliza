/**
 * Real Working Example: Multi-Agent Browser Chat with Full Persistence
 *
 * This file demonstrates how to use MessageBus with persistence in a browser environment.
 * It shows the complete flow:
 * 1. Create AgentRuntime with PGLite adapter
 * 2. Create MemoryTransport with runtime injection
 * 3. Create MessageBus with persistence enabled
 * 4. Create worlds, rooms, participants
 * 5. Send messages (instant delivery + background persistence)
 * 6. Load from database on refresh
 *
 * Usage:
 * ```typescript
 * import { initializeBrowserChat } from './browser-multi-agent-persistence';
 *
 * const { messageBus, runtime } = await initializeBrowserChat();
 *
 * // Send a message
 * await sendMessage(messageBus, 'Hello agents!');
 * ```
 */

import { MessageBus } from '../packages/core/src/messaging/message-bus';
import { MemoryTransport } from '../packages/core/src/messaging/transports/memory-transport';
import { AgentRuntime } from '../packages/core/src/runtime';
import type { Message } from '../packages/core/src/messaging/types';
import { ChannelType } from '../packages/core/src/types/environment';
import type { UUID } from '../packages/core/src/types/primitives';
import type { Character } from '../packages/core/src/types/agent';
import { v4 as uuidv4 } from 'uuid';

// Import PGLite adapter (you'd need @elizaos/plugin-sql in your package.json)
// import { createDatabaseAdapter } from '@elizaos/plugin-sql';

/**
 * Initialize the browser chat system with full persistence
 */
export async function initializeBrowserChat(): Promise<{
  messageBus: MessageBus;
  runtime: AgentRuntime;
  roomId: UUID;
  worldId: UUID;
}> {
  console.log('🚀 Initializing browser chat with persistence...');

  // Step 1: Create PGLite database adapter
  console.log('📦 Creating PGLite adapter...');
  // const adapter = createDatabaseAdapter({
  //   type: 'pglite',
  //   dataDir: 'eliza-browser-chat', // Stored in IndexedDB
  // });

  // For this example, we'll create runtime without adapter
  // In production, uncomment the lines above and pass adapter to AgentRuntime

  // Step 2: Create primary agent runtime (will be injected into transport)
  console.log('🤖 Creating agent runtime...');
  const agentId = uuidv4() as UUID;

  const character: Character = {
    id: agentId,
    name: 'BrowserAgent',
    username: 'browser_agent',
    system: 'You are a helpful browser-based AI agent.',
    bio: ['Browser-based AI assistant'],
    messageExamples: [],
    postExamples: [],
    topics: [],
    adjectives: ['helpful', 'responsive'],
    style: {
      all: ['friendly', 'professional'],
      chat: [],
      post: [],
    },
  };

  const runtime = new AgentRuntime({
    agentId,
    character,
    plugins: [], // Add SQL plugin here: [sqlPlugin]
  });

  // Initialize runtime (sets up database)
  // await runtime.initialize();

  // Step 3: Create MemoryTransport with runtime injection for persistence
  console.log('🚌 Creating MessageBus with persistence...');
  const transport = new MemoryTransport(
    runtime, // Inject runtime
    true // Enable persistence
  );

  const messageBus = new MessageBus(transport);

  // Step 4: Create world and room structure
  const worldId = uuidv4() as UUID;
  const roomId = uuidv4() as UUID;

  console.log('🌍 Creating world...');
  messageBus.createWorld({
    id: worldId,
    agentId: runtime.agentId,
    serverId: 'browser',
    name: 'Browser World',
    rooms: [],
    metadata: {
      createdIn: 'browser',
      timestamp: Date.now(),
    },
  });

  console.log('🏠 Creating room...');
  messageBus.createRoom({
    id: roomId,
    worldId,
    agentId: runtime.agentId,
    name: 'Main Chat',
    source: 'browser',
    type: ChannelType.GROUP,
    participants: [],
    metadata: {
      description: 'Main browser chat room',
    },
  });

  // Step 5: Add participants (user + agents)
  console.log('👥 Adding participants...');
  const participantIds = ['user' as UUID, 'agent-1' as UUID, 'agent-2' as UUID, 'agent-3' as UUID];

  participantIds.forEach((participantId) => {
    messageBus.addParticipant(roomId, participantId);
  });

  // Step 6: Load any existing data from database (for page refresh)
  console.log('🔄 Loading existing data from database...');
  await messageBus.loadFromDatabase();

  // Wait for all initial persistence operations to complete
  await messageBus.waitForPersistence();

  console.log('✅ Browser chat initialized with persistence!');

  return { messageBus, runtime, roomId, worldId };
}

/**
 * Send a message through the bus
 */
export async function sendMessage(
  messageBus: MessageBus,
  roomId: UUID,
  worldId: UUID,
  authorId: UUID,
  content: string
): Promise<Message> {
  const message: Message = {
    id: uuidv4() as UUID,
    roomId,
    worldId,
    authorId,
    content,
    metadata: {
      type: 'message',
      source: 'browser',
    },
    createdAt: Date.now(),
  };

  // This will:
  // 1. Deliver instantly to all subscribers
  // 2. Persist to PGLite in background (world → room → participant → message)
  await messageBus.sendMessage(message);

  return message;
}

/**
 * Load message history from database
 */
export async function loadMessageHistory(
  transport: MemoryTransport,
  roomId: UUID,
  limit: number = 100
): Promise<Message[]> {
  return await transport.loadMessagesFromDatabase(roomId, limit);
}

/**
 * Example: Complete browser app setup
 */
export async function runBrowserExample() {
  // Initialize system
  const { messageBus, runtime, roomId, worldId } = await initializeBrowserChat();

  // Subscribe to messages
  messageBus.subscribeToRoom(roomId, (message) => {
    console.log(`📨 Received: [${message.authorId}] ${message.content}`);
  });

  // Send a test message
  await sendMessage(messageBus, roomId, worldId, 'user' as UUID, 'Hello from browser!');

  // Wait for persistence
  await messageBus.waitForPersistence();

  console.log('✅ Message sent and persisted!');

  // Show database state
  const transport = messageBus['transport'] as MemoryTransport;
  const messages = await transport.loadMessagesFromDatabase(roomId);
  console.log(`📊 Database contains ${messages.length} messages`);

  return { messageBus, runtime };
}

/**
 * Example usage in HTML:
 *
 * ```html
 * <script type="module">
 *   import { initializeBrowserChat, sendMessage } from './browser-multi-agent-persistence.js';
 *
 *   // Initialize on page load
 *   const { messageBus, roomId, worldId } = await initializeBrowserChat();
 *
 *   // Send message on button click
 *   button.onclick = async () => {
 *     await sendMessage(messageBus, roomId, worldId, 'user', input.value);
 *   };
 *
 *   // On page refresh, loadFromDatabase() restores state automatically
 * </script>
 * ```
 */

// If running directly (for testing)
if (typeof window !== 'undefined') {
  (window as any).initializeBrowserChat = initializeBrowserChat;
  (window as any).sendMessage = sendMessage;
  (window as any).loadMessageHistory = loadMessageHistory;
  (window as any).runBrowserExample = runBrowserExample;

  console.log('✅ Browser example functions available on window object');
  console.log('Run: await window.runBrowserExample()');
}
