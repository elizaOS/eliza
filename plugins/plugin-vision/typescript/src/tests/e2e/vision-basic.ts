import type { TestSuite, IAgentRuntime, Memory, State } from '@elizaos/core';
import { createUniqueUuid } from '@elizaos/core';
import { VisionService } from '../../service';
import { describeSceneAction, captureImageAction } from '../../action';

export class VisionBasicE2ETestSuite implements TestSuite {
  name = 'plugin-vision-basic-e2e';
  description = 'Basic end-to-end tests for vision plugin functionality';

  tests = [
    {
      name: 'Should initialize vision service',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing vision service initialization...');

        const visionService = runtime.getService<VisionService>('VISION' as any);
        if (!visionService) {
          throw new Error('Vision service not available - service must be registered');
        }

        // Check if service is active
        const isActive = visionService.isActive();

        // Get camera info
        const cameraInfo = visionService.getCameraInfo();

        if (!isActive || !cameraInfo) {
          // For CI/CD environments without cameras, check that service at least initializes
          console.warn('⚠️  No camera detected. Service initialized but not active.');
          console.log('   This is acceptable in CI/CD environments without cameras.');
        } else {
          console.log('✓ Vision service initialized and active');
          console.log(`✓ Connected to camera: ${cameraInfo.name} (ID: ${cameraInfo.id})`);
        }
      },
    },

    {
      name: 'Should describe scene when requested',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing scene description action...');

        const roomId = createUniqueUuid(runtime, 'test-room');
        const message: Memory = {
          id: createUniqueUuid(runtime, 'test-msg-describe'),
          entityId: runtime.agentId,
          content: { text: 'what do you see?' },
          agentId: runtime.agentId,
          roomId,
          createdAt: Date.now(),
        };

        let callbackCalled = false;
        let callbackResponse: any = null;

        const state: State = { values: {}, data: {}, text: '' };

        // Get vision service to check if active
        const visionService = runtime.getService<VisionService>('VISION' as any);

        // Validate the action
        const isValid = await describeSceneAction.validate(runtime, message, state);

        if (!visionService || !visionService.isActive()) {
          // If vision service is not active, validation should return false
          if (isValid) {
            throw new Error(
              'Action validation should return false when vision service is not active'
            );
          }
          console.log('  Action validation correctly returned false (vision not active)');

          // But handler should still work and provide appropriate message
          await describeSceneAction.handler(runtime, message, state, {}, async (response) => {
            callbackCalled = true;
            callbackResponse = response;
            return [];
          });

          if (!callbackCalled) {
            throw new Error('Callback was not called - action handler failed');
          }

          if (!callbackResponse || !callbackResponse.text) {
            throw new Error('No response text returned from action');
          }

          console.log('✓ Scene description action handled unavailability correctly');
          console.log(`  Response: ${callbackResponse.text}`);

          // Verify it indicates camera not available
          if (
            !callbackResponse.text.includes('cannot see') &&
            !callbackResponse.text.includes('no camera')
          ) {
            throw new Error('Response does not indicate camera unavailability');
          }
        } else {
          // Vision is active, normal test flow
          if (!isValid) {
            throw new Error('describeSceneAction validation failed despite active vision');
          }
          console.log('  Action validation: passed');

          await describeSceneAction.handler(runtime, message, state, {}, async (response) => {
            callbackCalled = true;
            callbackResponse = response;
            return [];
          });

          if (!callbackCalled) {
            throw new Error('Callback was not called - action handler failed');
          }

          if (!callbackResponse || !callbackResponse.text) {
            throw new Error('No response text returned from action');
          }

          console.log('✓ Scene description action executed');
          console.log(`  Response: ${callbackResponse.text}`);
          if (callbackResponse.thought) {
            console.log(`  Thought: ${callbackResponse.thought}`);
          }
        }

        // Verify response contains expected action
        if (!callbackResponse.actions || !callbackResponse.actions.includes('DESCRIBE_SCENE')) {
          throw new Error('Response does not include DESCRIBE_SCENE action');
        }
      },
    },

    {
      name: 'Should capture image when requested',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing image capture action...');

        const roomId = createUniqueUuid(runtime, 'test-room');
        const message: Memory = {
          id: createUniqueUuid(runtime, 'test-msg-capture'),
          entityId: runtime.agentId,
          content: { text: 'take a photo' },
          agentId: runtime.agentId,
          roomId,
          createdAt: Date.now(),
        };

        let callbackCalled = false;
        let callbackResponse: any = null;

        const state: State = { values: {}, data: {}, text: '' };

        // Get vision service to check if active
        const visionService = runtime.getService<VisionService>('VISION' as any);

        // Validate the action
        const isValid = await captureImageAction.validate(runtime, message, state);

        if (!visionService || !visionService.isActive()) {
          // If vision service is not active, validation should return false
          if (isValid) {
            throw new Error(
              'Action validation should return false when vision service is not active'
            );
          }
          console.log('  Action validation correctly returned false (vision not active)');

          // But handler should still work and provide appropriate message
          await captureImageAction.handler(runtime, message, state, {}, async (response) => {
            callbackCalled = true;
            callbackResponse = response;
            return [];
          });

          if (!callbackCalled) {
            throw new Error('Callback was not called - action handler failed');
          }

          if (!callbackResponse || !callbackResponse.text) {
            throw new Error('No response text returned from action');
          }

          console.log('✓ Image capture action handled unavailability correctly');
          console.log(`  Response: ${callbackResponse.text}`);

          // Verify it indicates camera not available
          if (
            !callbackResponse.text.includes('cannot capture') &&
            !callbackResponse.text.includes('no camera')
          ) {
            throw new Error('Response does not indicate camera unavailability');
          }
        } else {
          // Vision is active, normal test flow
          if (!isValid) {
            throw new Error('captureImageAction validation failed despite active vision');
          }
          console.log('  Action validation: passed');

          await captureImageAction.handler(runtime, message, state, {}, async (response) => {
            callbackCalled = true;
            callbackResponse = response;
            return [];
          });

          if (!callbackCalled) {
            throw new Error('Callback was not called - action handler failed');
          }

          if (!callbackResponse || !callbackResponse.text) {
            throw new Error('No response text returned from action');
          }

          console.log('✓ Image capture action executed');
          console.log(`  Response: ${callbackResponse.text}`);

          // If camera is active, we should have an attachment
          if (!callbackResponse.attachments || callbackResponse.attachments.length === 0) {
            throw new Error('No image attachment returned despite active camera');
          }

          const attachment = callbackResponse.attachments[0];
          if (!attachment.url || !attachment.url.startsWith('data:image/')) {
            throw new Error('Invalid image attachment format');
          }

          console.log(`  ✓ Image attachment valid: ${attachment.title}`);
        }

        // Verify response contains expected action
        if (!callbackResponse.actions || !callbackResponse.actions.includes('CAPTURE_IMAGE')) {
          throw new Error('Response does not include CAPTURE_IMAGE action');
        }
      },
    },

    {
      name: 'Should provide vision context through provider',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing vision provider...');

        // Compose state to trigger providers
        const message: Memory = {
          id: createUniqueUuid(runtime, 'test-msg-provider'),
          entityId: runtime.agentId,
          content: { text: 'test provider' },
          agentId: runtime.agentId,
          roomId: createUniqueUuid(runtime, 'test-room'),
          createdAt: Date.now(),
        };

        const state = await runtime.composeState(message);

        // Vision provider should always add data
        if (state.values.visionAvailable === undefined) {
          throw new Error('Vision provider data missing - provider not registered or failed');
        }

        console.log('✓ Vision provider data found in state');
        console.log(`  Vision available: ${state.values.visionAvailable}`);
        console.log(`  Camera status: ${state.values.cameraStatus}`);

        // Verify vision context in formatted text
        if (!state.text.includes('Visual Perception')) {
          throw new Error('Vision context not included in state text');
        }
        console.log('✓ Vision context included in state text');

        // If vision is available, verify scene data
        if (state.values.visionAvailable && state.values.sceneDescription) {
          console.log(`  Scene description: ${state.values.sceneDescription}`);
        }
      },
    },

    {
      name: 'Should handle scene changes efficiently',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing scene change detection...');

        const visionService = runtime.getService<VisionService>('VISION' as any);
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        if (!visionService.isActive()) {
          console.warn('⚠️  Vision service not active - skipping scene change test');
          console.log('   This is acceptable in environments without cameras');
          return;
        }

        // Get initial scene description
        const initialScene = await visionService.getSceneDescription();
        console.log(`  Initial scene: ${initialScene ? 'Available' : 'Pending...'}`);

        // Wait for scene processing
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Get updated scene description
        const updatedScene = await visionService.getSceneDescription();

        if (!updatedScene) {
          throw new Error('No scene description available after 2 seconds');
        }

        console.log('✓ Scene monitoring active');
        console.log(`  Scene timestamp: ${new Date(updatedScene.timestamp).toISOString()}`);
        console.log(`  Description: ${updatedScene.description.substring(0, 100)}...`);

        if (updatedScene.changePercentage !== undefined) {
          console.log(`  Last change: ${updatedScene.changePercentage.toFixed(1)}%`);
        }
      },
    },

    {
      name: 'Should detect objects and people in scene',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing object and person detection...');

        const visionService = runtime.getService<VisionService>('VISION' as any);
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        if (!visionService.isActive()) {
          console.warn('⚠️  Vision service not active - skipping detection test');
          console.log('   This is acceptable in environments without cameras');
          return;
        }

        // Wait for scene processing to accumulate frames
        console.log('  Waiting for scene analysis...');
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Get scene description
        const scene = await visionService.getSceneDescription();

        if (!scene) {
          throw new Error('No scene description available after 3 seconds');
        }

        console.log('✓ Scene analysis complete');
        console.log(`  Description: ${scene.description.substring(0, 100)}...`);
        console.log(`  Objects detected: ${scene.objects.length}`);
        console.log(`  People detected: ${scene.people.length}`);

        // Verify object detection
        if (scene.objects.length > 0) {
          console.log('  Detected objects:');
          const objectTypes = scene.objects.reduce(
            (acc, obj) => {
              acc[obj.type] = (acc[obj.type] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>
          );

          for (const [type, count] of Object.entries(objectTypes)) {
            console.log(`    - ${count} ${type}(s)`);
          }

          // Verify objects have required fields
          for (const obj of scene.objects) {
            if (!obj.id || !obj.type || obj.confidence === undefined || !obj.boundingBox) {
              throw new Error('Detected object missing required fields');
            }
          }
        }

        // Verify person detection
        if (scene.people.length > 0) {
          console.log('  Detected people:');
          for (const person of scene.people) {
            console.log(
              `    - Person ${person.id}: ${person.pose} pose, facing ${person.facing}, confidence ${person.confidence.toFixed(2)}`
            );

            // Verify person has required fields
            if (
              !person.id ||
              !person.pose ||
              !person.facing ||
              person.confidence === undefined ||
              !person.boundingBox
            ) {
              throw new Error('Detected person missing required fields');
            }
          }
        }

        // If there's motion, we should detect something
        if (scene.changePercentage > 10) {
          console.log(`  Scene change: ${scene.changePercentage.toFixed(1)}%`);
          if (scene.objects.length === 0 && scene.people.length === 0) {
            console.warn('  ⚠️  Significant scene change but no objects/people detected');
            console.log('     This might indicate the motion detection threshold needs adjustment');
          }
        }
      },
    },
  ];
}

export default new VisionBasicE2ETestSuite();
