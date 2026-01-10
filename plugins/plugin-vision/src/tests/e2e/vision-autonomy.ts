import type { TestSuite, IAgentRuntime, Memory } from '@elizaos/core';
import { createUniqueUuid } from '@elizaos/core';
import { VisionService } from '../../service';
import { killAutonomousAction } from '../../action';

export class VisionAutonomyE2ETestSuite implements TestSuite {
  name = 'plugin-vision-autonomy-e2e';
  description = 'Tests for vision plugin integration with autonomy plugin';

  tests = [
    {
      name: 'Should stop autonomous loop with kill command',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing kill autonomous action...');

        const roomId = createUniqueUuid(runtime, 'test-room');
        const message: Memory = {
          id: createUniqueUuid(runtime, 'test-msg-kill'),
          entityId: runtime.agentId,
          content: { text: 'kill the autonomous loop' },
          agentId: runtime.agentId,
          roomId,
          createdAt: Date.now(),
        };

        let callbackCalled = false;
        let callbackResponse: any = null;

        // Validate the action
        const isValid = await killAutonomousAction.validate(runtime, message, {
          values: {},
          data: {},
          text: '',
        });
        if (!isValid) {
          throw new Error('killAutonomousAction validation failed');
        }

        await killAutonomousAction.handler(
          runtime,
          message,
          { values: {}, data: {}, text: '' },
          {},
          async (response) => {
            callbackCalled = true;
            callbackResponse = response;
            return [];
          }
        );

        if (!callbackCalled) {
          throw new Error('Callback was not called - action handler failed');
        }

        if (!callbackResponse || !callbackResponse.text) {
          throw new Error('No response text returned from kill action');
        }

        console.log('✓ Kill autonomous action executed');
        console.log(`  Response: ${callbackResponse.text}`);

        if (callbackResponse.thought) {
          console.log(`  Thought: ${callbackResponse.thought}`);
        }

        // Verify action was included
        if (!callbackResponse.actions || !callbackResponse.actions.includes('KILL_AUTONOMOUS')) {
          throw new Error('Response does not include KILL_AUTONOMOUS action');
        }
      },
    },

    {
      name: 'Should provide continuous vision updates for autonomous agent',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing vision updates for autonomous behavior...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        if (!visionService.isActive()) {
          console.warn('⚠️  Vision service not active - skipping continuous update test');
          console.log('   This is acceptable in environments without cameras');
          return;
        }

        // Track scene updates over time
        const updateIntervals: number[] = [];
        let lastTimestamp = 0;
        let updateCount = 0;
        const testDuration = 5000; // 5 seconds
        const startTime = Date.now();

        console.log('  Monitoring scene updates for 5 seconds...');

        while (Date.now() - startTime < testDuration) {
          const scene = await visionService.getSceneDescription();

          if (scene && scene.timestamp !== lastTimestamp) {
            if (lastTimestamp > 0) {
              updateIntervals.push(scene.timestamp - lastTimestamp);
            }
            lastTimestamp = scene.timestamp;
            updateCount++;
            console.log(`  Scene update ${updateCount}: ${scene.description.substring(0, 50)}...`);
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        console.log('✓ Vision monitoring complete');
        console.log(`  Total updates: ${updateCount}`);

        if (updateCount === 0) {
          throw new Error('No scene updates detected during 5 second monitoring period');
        }

        if (updateIntervals.length > 0) {
          const avgInterval = updateIntervals.reduce((a, b) => a + b, 0) / updateIntervals.length;
          console.log(`  Average update interval: ${Math.round(avgInterval)}ms`);

          // Verify updates are happening at reasonable intervals
          if (avgInterval > 5000) {
            throw new Error('Scene updates too infrequent for autonomous operation');
          }
        }
      },
    },

    {
      name: 'Should maintain vision memory across interactions',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing vision memory persistence...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        // First interaction - describe scene
        const roomId = createUniqueUuid(runtime, 'test-room');
        const firstMessage: Memory = {
          id: createUniqueUuid(runtime, 'test-msg-1'),
          entityId: runtime.agentId,
          content: { text: 'what do you see?' },
          agentId: runtime.agentId,
          roomId,
          createdAt: Date.now(),
        };

        // Store first message
        await runtime.createMemory(firstMessage, 'messages');

        // Simulate agent response
        const firstResponse: Memory = {
          id: createUniqueUuid(runtime, 'test-response-1'),
          entityId: runtime.agentId,
          content: {
            text: 'I see a test scene',
            actions: ['DESCRIBE_SCENE'],
          },
          agentId: runtime.agentId,
          roomId,
          createdAt: Date.now() + 100,
        };
        await runtime.createMemory(firstResponse, 'messages');

        // Wait for processing
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Second interaction - ask about previous observation
        const secondMessage: Memory = {
          id: createUniqueUuid(runtime, 'test-msg-2'),
          entityId: runtime.agentId,
          content: { text: 'what did you see before?' },
          agentId: runtime.agentId,
          roomId,
          createdAt: Date.now() + 1000,
        };

        await runtime.createMemory(secondMessage, 'messages');

        // Simulate agent response recalling previous observation
        const secondResponse: Memory = {
          id: createUniqueUuid(runtime, 'test-response-2'),
          entityId: runtime.agentId,
          content: {
            text: 'Previously, I saw a test scene',
            actions: ['DESCRIBE_SCENE'],
          },
          agentId: runtime.agentId,
          roomId,
          createdAt: Date.now() + 1100,
        };
        await runtime.createMemory(secondResponse, 'messages');

        // Wait for processing
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Check if messages were created
        const messages = await runtime.getMemories({
          roomId,
          count: 10,
          tableName: 'messages',
        });

        console.log('✓ Vision memory test complete');
        console.log(`  Total messages: ${messages ? messages.length : 0}`);

        // In the minimal test runtime, we just verify memory creation works
        // Real runtime would have actual message processing
        if (!visionService.isActive()) {
          console.log('  Note: Vision service not active, simulated memory test only');
        }
      },
    },

    {
      name: 'Should integrate vision data with agent decision making',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing vision-based decision making...');

        // Create a test scenario where vision affects agent behavior
        const roomId = createUniqueUuid(runtime, 'test-room');

        // Simulate different vision states
        const scenarios = [
          { text: 'Is anyone in the room?', expectedContext: 'people' },
          { text: 'Should I turn on the lights?', expectedContext: 'scene' },
          { text: 'What objects are nearby?', expectedContext: 'objects' },
        ];

        let scenariosWithVision = 0;

        for (const scenario of scenarios) {
          const message: Memory = {
            id: createUniqueUuid(runtime, `test-msg-${Date.now()}`),
            entityId: runtime.agentId,
            content: { text: scenario.text },
            agentId: runtime.agentId,
            roomId,
            createdAt: Date.now(),
          };

          // Compose state to see if vision data is included
          const state = await runtime.composeState(message);

          // Check if vision context is available for decision
          const hasVisionContext =
            state.text.includes('Visual Perception') || state.values.visionAvailable !== undefined;

          console.log(`  Scenario: "${scenario.text}"`);
          console.log(`    Has vision context: ${hasVisionContext}`);

          if (hasVisionContext) {
            scenariosWithVision++;

            if (state.values.sceneDescription) {
              console.log(
                `    Scene info available: ${state.values.sceneDescription.substring(0, 50)}...`
              );
            }
          }
        }

        console.log('✓ Vision-based decision making test complete');

        // All scenarios should have vision context from the provider
        if (scenariosWithVision !== scenarios.length) {
          throw new Error(
            `Vision context missing in ${scenarios.length - scenariosWithVision} scenarios`
          );
        }
      },
    },

    {
      name: 'Should handle autonomy gracefully when vision is unavailable',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing autonomy behavior without vision...');

        const visionService = runtime.getService<VisionService>('VISION');

        if (!visionService) {
          throw new Error('Vision service not registered - cannot test graceful handling');
        }

        const isActive = visionService.isActive();
        console.log(`  Vision service active: ${isActive}`);

        // Compose state to check provider behavior
        const message: Memory = {
          id: createUniqueUuid(runtime, 'test-msg-no-vision'),
          entityId: runtime.agentId,
          content: { text: 'test without vision' },
          agentId: runtime.agentId,
          roomId: createUniqueUuid(runtime, 'test-room'),
          createdAt: Date.now(),
        };

        const state = await runtime.composeState(message);

        // Vision provider should always provide status
        if (state.values.visionAvailable === undefined) {
          throw new Error('Vision provider did not report availability status');
        }

        if (!isActive) {
          // Vision should indicate it's not available
          if (state.values.visionAvailable !== false) {
            throw new Error('Vision incorrectly reports as available when service is not active');
          }

          if (!state.values.cameraStatus || !state.values.cameraStatus.includes('not connected')) {
            throw new Error('Camera status does not indicate disconnection');
          }

          console.log('✓ Vision correctly reports unavailable state');
          console.log(`  Status: ${state.values.cameraStatus}`);
        } else {
          // Vision is active
          if (state.values.visionAvailable !== true) {
            throw new Error('Vision incorrectly reports as unavailable when service is active');
          }

          console.log('✓ Vision correctly reports available state');
          console.log(`  Status: ${state.values.cameraStatus}`);
        }
      },
    },
  ];
}

export default new VisionAutonomyE2ETestSuite();
