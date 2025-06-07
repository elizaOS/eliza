import {
  type IAgentRuntime,
  type Entity,
  type Room,
  type Content,
  type Memory,
  createUniqueUuid,
  EventType,
  asUUID,
  ChannelType,
  type World,
} from '@elizaos/core';
import { v4 as uuid } from 'uuid';
import { strict as assert } from 'node:assert';

/**
 * Sets up a standard scenario environment for an E2E test.
 *
 * This function creates a world, a user, and a room, providing an
 * isolated environment for each test case.
 *
 * @param runtime The live IAgentRuntime instance provided by the TestRunner.
 * @returns A promise that resolves to an object containing the created world, user, and room.
 */
export async function setupScenario(
  runtime: IAgentRuntime
): Promise<{ user: Entity; room: Room; world: World }> {
  assert(runtime.agentId, 'Runtime must have an agentId to run a scenario');

  // 1. Create a test user entity first, so we can assign ownership
  const user: Entity = {
    id: asUUID(uuid()),
    names: ['Test User'],
    agentId: runtime.agentId,
    metadata: { type: 'user' },
  };
  await runtime.createEntity(user);
  assert(user.id, 'Created user must have an id');

  // 2. Create a World and assign the user as the owner.
  // This is critical for providers that check for ownership.
  const world: World = {
    id: asUUID(uuid()),
    agentId: runtime.agentId,
    name: 'E2E Test World',
    serverId: 'e2e-test-server',
    metadata: {
      ownership: {
        ownerId: user.id,
      },
    },
  };
  await runtime.ensureWorldExists(world);

  // 3. Create a test room associated with the world
  const room: Room = {
    id: asUUID(uuid()),
    name: 'Test DM Room',
    type: ChannelType.DM,
    source: 'e2e-test',
    worldId: world.id,
    serverId: world.serverId,
  };
  await runtime.createRoom(room);

  // 4. Ensure both the agent and the user are participants in the room
  await runtime.ensureParticipantInRoom(runtime.agentId, room.id);
  await runtime.ensureParticipantInRoom(user.id, room.id);

  return { user, room, world };
}

/**
 * Simulates a user sending a message and waits for the agent's response.
 *
 * This function abstracts the event-driven nature of the message handler
 * into a simple async function, making tests easier to write and read.
 *
 * @param runtime The live IAgentRuntime instance.
 * @param room The room where the message is sent.
 * @param user The user entity sending the message.
 * @param text The content of the message.
 * @returns A promise that resolves with the agent's response content.
 */
export function sendMessageAndWaitForResponse(
  runtime: IAgentRuntime,
  room: Room,
  user: Entity,
  text: string
): Promise<Content> {
  return new Promise((resolve) => {
    assert(runtime.agentId, 'Runtime must have an agentId to send a message');
    assert(user.id, 'User must have an id to send a message');

    // Construct the message object, simulating an incoming message from a user
    const message: Memory = {
      id: createUniqueUuid(runtime, `${user.id}-${Date.now()}`),
      agentId: runtime.agentId,
      entityId: user.id,
      roomId: room.id,
      content: {
        text,
      },
      createdAt: Date.now(),
    };

    // The callback function that the message handler will invoke with the agent's final response.
    // We use this callback to resolve our promise.
    const callback = (responseContent: Content) => {
      resolve(responseContent);
    };

    // Emit the event to trigger the agent's message processing logic.
    runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime,
      message,
      callback,
    });
  });
}
