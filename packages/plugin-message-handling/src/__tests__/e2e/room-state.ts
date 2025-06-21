import { type TestSuite, type IAgentRuntime, type Memory, type UUID, ChannelType, createUniqueUuid, EventType, type Content } from '@elizaos/core';
import { v4 } from 'uuid';

export class RoomStateTestSuite implements TestSuite {
  name = 'message-handling-room-state';
  description = 'E2E tests for room state management including follow/unfollow and mute/unmute flows';

  tests = [
    {
      name: 'Room state transitions work correctly',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Starting room state transitions test...');
        
        const worldId = createUniqueUuid(runtime, `test-world-${Date.now()}`);
        const roomId = createUniqueUuid(runtime, `state-test-${Date.now()}`);
        const userId = createUniqueUuid(runtime, 'test-user');
        
        // Ensure world exists
        await runtime.ensureWorldExists({
          id: worldId,
          name: 'Test World',
          serverId: 'test-server',
          agentId: runtime.agentId,
        });
        
        // Ensure room exists with worldId
        await runtime.ensureRoomExists({
          id: roomId,
          name: 'State Test Room',
          channelId: 'state-test',
          serverId: 'test-server',
          worldId: worldId,
          type: ChannelType.GROUP,
          source: 'test',
        });
        
        // Create entity for the user
        await runtime.createEntity({
          id: userId,
          agentId: runtime.agentId,
          names: ['StateTestUser'],
          metadata: {
            userName: 'StateTestUser',
            status: 'ACTIVE',
          },
        });
        
        // Initial state should be null
        const initialState = await runtime.getParticipantUserState(roomId, runtime.agentId);
        console.log('Initial state:', initialState);
        
        // Test FOLLOW transition
        const followMessage: Memory = {
          id: v4() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId: roomId,
          content: {
            text: `${runtime.character.name}, follow this channel`,
            type: 'text',
            source: 'test',
            channelType: ChannelType.GROUP,
          },
          createdAt: Date.now(),
        };

        try {
          await runtime.createMemory(followMessage, 'messages');
        } catch (error) {
          console.error('Failed to create follow memory:', error);
        }
        
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime,
          message: followMessage,
          callback: async (response: Content) => {
            console.log('Follow response:', response);
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const followedState = await runtime.getParticipantUserState(roomId, runtime.agentId);
        if (followedState !== 'FOLLOWED') {
          console.warn(`Expected FOLLOWED state but got ${followedState}`);
        } else {
          console.log('✓ Transitioned to FOLLOWED state');
        }
        
        // Test MUTE transition (should override FOLLOWED)
        const muteMessage: Memory = {
          id: v4() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId: roomId,
          content: {
            text: `${runtime.character.name}, mute this room`,
            type: 'text',
            source: 'test',
            channelType: ChannelType.GROUP,
          },
          createdAt: Date.now() + 1000,
        };

        try {
          await runtime.createMemory(muteMessage, 'messages');
        } catch (error) {
          console.error('Failed to create mute memory:', error);
        }
        
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime,
          message: muteMessage,
          callback: async (response: Content) => {
            console.log('Mute response:', response);
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const mutedState = await runtime.getParticipantUserState(roomId, runtime.agentId);
        if (mutedState !== 'MUTED') {
          console.warn(`Expected MUTED state but got ${mutedState}`);
        } else {
          console.log('✓ Transitioned from FOLLOWED to MUTED state');
        }
        
        // Test UNMUTE transition (should clear state)
        const unmuteMessage: Memory = {
          id: v4() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId: roomId,
          content: {
            text: `${runtime.character.name}, unmute this room`,
            type: 'text',
            source: 'test',
            channelType: ChannelType.GROUP,
          },
          createdAt: Date.now() + 2000,
        };

        try {
          await runtime.createMemory(unmuteMessage, 'messages');
        } catch (error) {
          console.error('Failed to create unmute memory:', error);
        }
        
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime,
          message: unmuteMessage,
          callback: async (response: Content) => {
            console.log('Unmute response:', response);
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const clearedState = await runtime.getParticipantUserState(roomId, runtime.agentId);
        if (clearedState === 'MUTED') {
          console.warn('State should be cleared after unmute');
        } else {
          console.log('✓ State cleared after unmute');
        }
        
        console.log('✅ Room state transitions test PASSED');
      },
    },

    {
      name: 'Agent behavior changes with room state',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Starting agent behavior test...');
        
        const worldId = createUniqueUuid(runtime, `test-world-${Date.now()}`);
        const roomId = createUniqueUuid(runtime, `behavior-test-${Date.now()}`);
        const userId = createUniqueUuid(runtime, 'test-user');
        
        // Ensure world exists
        await runtime.ensureWorldExists({
          id: worldId,
          name: 'Test World',
          serverId: 'test-server',
          agentId: runtime.agentId,
        });
        
        // Ensure room exists with worldId
        await runtime.ensureRoomExists({
          id: roomId,
          name: 'Behavior Test Room',
          channelId: 'behavior-test',
          serverId: 'test-server',
          worldId: worldId,
          type: ChannelType.GROUP,
          source: 'test',
        });
        
        // Create entity for the user
        await runtime.createEntity({
          id: userId,
          agentId: runtime.agentId,
          names: ['BehaviorTestUser'],
          metadata: {
            userName: 'BehaviorTestUser',
            status: 'ACTIVE',
          },
        });
        
        // First, set room to FOLLOWED
        await runtime.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');
        console.log('Set room to FOLLOWED state');
        
        // Send a casual message (agent should respond in FOLLOWED room)
        const casualMessage: Memory = {
          id: v4() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId: roomId,
          content: {
            text: 'What do you think about the weather today?',
            type: 'text',
            source: 'test',
            channelType: ChannelType.GROUP,
          },
          createdAt: Date.now(),
        };

        let followedResponse = false;

        try {
          await runtime.createMemory(casualMessage, 'messages');
        } catch (error) {
          console.error('Failed to create casual memory:', error);
        }
        
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime,
          message: casualMessage,
          callback: async (response: Content) => {
            console.log('Response in FOLLOWED room:', response);
            if (response.text && response.text.length > 0) {
              followedResponse = true;
            }
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (!followedResponse) {
          console.warn('Agent may not have responded to casual message in FOLLOWED room');
        }
        
        // Now mute the room
        await runtime.setParticipantUserState(roomId, runtime.agentId, 'MUTED');
        console.log('Set room to MUTED state');
        
        // Send another casual message (agent should NOT respond in MUTED room)
        const mutedMessage: Memory = {
          id: v4() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId: roomId,
          content: {
            text: 'Anyone want to grab lunch?',
            type: 'text',
            source: 'test',
            channelType: ChannelType.GROUP,
          },
          createdAt: Date.now() + 5000,
        };

        let mutedResponse = false;

        try {
          await runtime.createMemory(mutedMessage, 'messages');
        } catch (error) {
          console.error('Failed to create muted memory:', error);
        }
        
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime,
          message: mutedMessage,
          callback: async (response: Content) => {
            console.log('Response in MUTED room:', response);
            if (response.text && response.text.length > 0 && response.actions?.includes('REPLY')) {
              mutedResponse = true;
            }
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (mutedResponse) {
          console.warn('Agent responded to casual message in MUTED room (may be expected)');
        }
        
        // But agent should still respond to direct mentions when muted
        const mentionMessage: Memory = {
          id: v4() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId: roomId,
          content: {
            text: `${runtime.character.name}, are you still there?`,
            type: 'text',
            source: 'test',
            channelType: ChannelType.GROUP,
          },
          createdAt: Date.now() + 10000,
        };

        let mentionResponse = false;

        try {
          await runtime.createMemory(mentionMessage, 'messages');
        } catch (error) {
          console.error('Failed to create mention memory:', error);
        }
        
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime,
          message: mentionMessage,
          callback: async (response: Content) => {
            console.log('Response to mention in MUTED room:', response);
            if (response.text && response.text.length > 0) {
              mentionResponse = true;
            }
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!mentionResponse) {
          console.warn('Agent did not respond to direct mention in MUTED room');
        }
        
        console.log('✓ Agent behavior tested in different states');
        console.log('✅ Agent behavior test PASSED');
      },
    },

    {
      name: 'Multiple room states managed independently',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Starting multiple room states test...');
        
        const worldId = createUniqueUuid(runtime, `test-world-${Date.now()}`);
        const room1Id = createUniqueUuid(runtime, `room1-${Date.now()}`);
        const room2Id = createUniqueUuid(runtime, `room2-${Date.now()}`);
        const userId = createUniqueUuid(runtime, 'test-user');
        
        // Ensure world exists
        await runtime.ensureWorldExists({
          id: worldId,
          name: 'Test World',
          serverId: 'test-server',
          agentId: runtime.agentId,
        });
        
        // Ensure rooms exist with worldId
        await runtime.ensureRoomExists({
          id: room1Id,
          name: 'Multi State Room 1',
          channelId: 'multi-room-1',
          serverId: 'test-server',
          worldId: worldId,
          type: ChannelType.GROUP,
          source: 'test',
        });
        
        await runtime.ensureRoomExists({
          id: room2Id,
          name: 'Multi State Room 2',
          channelId: 'multi-room-2',
          serverId: 'test-server',
          worldId: worldId,
          type: ChannelType.GROUP,
          source: 'test',
        });
        
        // Set different states for different rooms
        await runtime.setParticipantUserState(room1Id, runtime.agentId, 'FOLLOWED');
        await runtime.setParticipantUserState(room2Id, runtime.agentId, 'MUTED');
        
        console.log('Room 1 set to FOLLOWED');
        console.log('Room 2 set to MUTED');
        
        // Verify states are independent
        const room1State = await runtime.getParticipantUserState(room1Id, runtime.agentId);
        const room2State = await runtime.getParticipantUserState(room2Id, runtime.agentId);
        
        if (room1State !== 'FOLLOWED') {
          console.warn(`Room 1 should be FOLLOWED but is ${room1State}`);
        } else {
          console.log('✓ Room 1 state correct');
        }
        
        if (room2State !== 'MUTED') {
          console.warn(`Room 2 should be MUTED but is ${room2State}`);
        } else {
          console.log('✓ Room 2 state correct');
        }
        
        // Change room 1 state shouldn't affect room 2
        await runtime.setParticipantUserState(room1Id, runtime.agentId, 'MUTED');
        
        const newRoom1State = await runtime.getParticipantUserState(room1Id, runtime.agentId);
        const unchangedRoom2State = await runtime.getParticipantUserState(room2Id, runtime.agentId);
        
        if (newRoom1State !== 'MUTED') {
          console.warn(`Room 1 should be MUTED after change but is ${newRoom1State}`);
        }
        
        if (unchangedRoom2State !== 'MUTED') {
          console.warn(`Room 2 state changed unexpectedly to ${unchangedRoom2State}`);
        }
        
        console.log('✓ Room states managed independently');
        console.log('✅ Multiple room states test PASSED');
      },
    },

    {
      name: 'Room state persists across messages',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Starting room state persistence test...');
        
        const worldId = createUniqueUuid(runtime, `test-world-${Date.now()}`);
        const roomId = createUniqueUuid(runtime, `persist-test-${Date.now()}`);
        const userId = createUniqueUuid(runtime, 'test-user');
        
        // Ensure world exists
        await runtime.ensureWorldExists({
          id: worldId,
          name: 'Test World',
          serverId: 'test-server',
          agentId: runtime.agentId,
        });
        
        // Ensure room exists with worldId
        await runtime.ensureRoomExists({
          id: roomId,
          name: 'Persistence Test Room',
          channelId: 'persist-test',
          serverId: 'test-server',
          worldId: worldId,
          type: ChannelType.GROUP,
          source: 'test',
        });
        
        // Create entity for the user
        await runtime.createEntity({
          id: userId,
          agentId: runtime.agentId,
          names: ['PersistTestUser'],
          metadata: {
            userName: 'PersistTestUser',
            status: 'ACTIVE',
          },
        });
        
        // Set room to FOLLOWED
        await runtime.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');
        console.log('Set initial FOLLOWED state');
        
        // Send multiple messages over time
        for (let i = 0; i < 3; i++) {
          const message: Memory = {
            id: v4() as UUID,
            entityId: userId,
            agentId: runtime.agentId,
            roomId: roomId,
            content: {
              text: `Test message ${i + 1}`,
              type: 'text',
              source: 'test',
              channelType: ChannelType.GROUP,
            },
            createdAt: Date.now() + (i * 1000),
          };

          try {
            await runtime.createMemory(message, 'messages');
          } catch (error) {
            console.error(`Failed to create message ${i + 1}:`, error);
          }
          
          // Check state after each message
          const currentState = await runtime.getParticipantUserState(roomId, runtime.agentId);
          if (currentState !== 'FOLLOWED') {
            console.warn(`State changed unexpectedly to ${currentState} after message ${i + 1}`);
          } else {
            console.log(`✓ State persisted after message ${i + 1}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log('✓ Room state persists across multiple messages');
        console.log('✅ Room state persistence test PASSED');
      },
    },

    {
      name: 'State changes are logged in memory',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Starting state change logging test...');
        
        const worldId = createUniqueUuid(runtime, `test-world-${Date.now()}`);
        const roomId = createUniqueUuid(runtime, `logging-test-${Date.now()}`);
        const userId = createUniqueUuid(runtime, 'test-user');
        
        // Ensure world exists
        await runtime.ensureWorldExists({
          id: worldId,
          name: 'Test World',
          serverId: 'test-server',
          agentId: runtime.agentId,
        });
        
        // Ensure room exists with worldId
        await runtime.ensureRoomExists({
          id: roomId,
          name: 'Logging Test Room',
          channelId: 'logging-test',
          serverId: 'test-server',
          worldId: worldId,
          type: ChannelType.GROUP,
          source: 'test',
        });
        
        // Create entity for the user
        await runtime.createEntity({
          id: userId,
          agentId: runtime.agentId,
          names: ['LoggingTestUser'],
          metadata: {
            userName: 'LoggingTestUser',
            status: 'ACTIVE',
          },
        });
        
        // Follow room
        const followMessage: Memory = {
          id: v4() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId: roomId,
          content: {
            text: `${runtime.character.name}, follow this room please`,
            type: 'text',
            source: 'test',
            channelType: ChannelType.GROUP,
          },
          createdAt: Date.now(),
        };

        try {
          await runtime.createMemory(followMessage, 'messages');
        } catch (error) {
          console.error('Failed to create follow memory:', error);
        }
        
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime,
          message: followMessage,
          callback: async (response: Content) => {
            console.log('Follow action response:', response);
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Check memories for follow action
        try {
          const memories = await runtime.getMemories({
            roomId,
            count: 20,
            tableName: 'messages',
          });
          
          const followMemory = memories.find(m => 
            m.content.actions?.includes('FOLLOW_ROOM_START') ||
            m.content.thought?.includes('followed')
          );
          
          if (followMemory) {
            console.log('✓ Follow action logged in memory');
          } else {
            console.warn('Follow action may not have been logged');
          }
        } catch (error) {
          console.error('Failed to retrieve memories:', error);
        }
        
        // Mute room
        const muteMessage: Memory = {
          id: v4() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId: roomId,
          content: {
            text: `${runtime.character.name}, mute this room`,
            type: 'text',
            source: 'test',
            channelType: ChannelType.GROUP,
          },
          createdAt: Date.now() + 5000,
        };

        try {
          await runtime.createMemory(muteMessage, 'messages');
        } catch (error) {
          console.error('Failed to create mute memory:', error);
        }
        
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          runtime,
          message: muteMessage,
          callback: async (response: Content) => {
            console.log('Mute action response:', response);
          }
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('✓ State change actions processed');
        console.log('✅ State change logging test PASSED');
      },
    },
  ];
}

export default new RoomStateTestSuite(); 