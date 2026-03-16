import {
  type Content,
  type Entity,
  type IAgentRuntime,
  type Memory,
  type Room,
  asUUID,
  ChannelType,
  createUniqueUuid,
  EventType,
} from '@elizaos/core';
import { strict as assert } from 'node:assert';
import { v4 as uuid } from 'uuid';

/**
 * Sets up a standard scenario environment for plugin manager E2E tests.
 *
 * This function creates a user and a room, providing an
 * isolated environment for each test case.
 *
 * @param runtime The live IAgentRuntime instance provided by the TestRunner.
 * @returns A promise that resolves to an object containing the created user and room.
 */
export async function setupScenario(runtime: IAgentRuntime): Promise<{ user: Entity; room: Room }> {
  assert(runtime.agentId, 'Runtime must have an agentId to run a scenario');

  // 1. Create a test user entity
  const user: Entity = {
    id: asUUID(uuid()),
    names: ['Test User'],
    agentId: runtime.agentId,
    metadata: { type: 'user' },
  };
  await runtime.createEntity(user);
  assert(user.id, 'Created user must have an id');

  // 2. Create a test room
  const room: Room = {
    id: asUUID(uuid()),
    name: 'Test Plugin Manager Room',
    type: ChannelType.DM,
    source: 'e2e-test',
    serverId: 'e2e-test-server',
  };
  await runtime.createRoom(room);

  // 3. Ensure both the agent and the user are participants in the room
  await runtime.ensureParticipantInRoom(runtime.agentId, room.id);
  await runtime.ensureParticipantInRoom(user.id, room.id);

  return { user, room };
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
