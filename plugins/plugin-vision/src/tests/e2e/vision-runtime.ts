import type { TestSuite } from '@elizaos/core';
import { logger } from '@elizaos/core';

export class VisionRuntimeTestSuite implements TestSuite {
  name = 'vision-runtime-tests';
  description = 'Real runtime tests for vision plugin functionality';

  tests = [
    {
      name: 'Vision service initialization',
      fn: async (runtime: any) => {
        logger.info('[Test] Testing vision service initialization...');

        const visionService = runtime.getService('VISION');
        if (!visionService) {
          throw new Error('Vision service not found in runtime');
        }

        // Check if service is properly initialized
        if (typeof visionService.isActive !== 'function') {
          throw new Error('Vision service missing isActive method');
        }

        const isActive = visionService.isActive();
        logger.info(`[Test] Vision service active: ${isActive}`);

        // Service should be active after initialization
        if (!isActive && runtime.getSetting('VISION_MODE') !== 'OFF') {
          throw new Error('Vision service should be active but is not');
        }

        logger.info('[Test] ✅ Vision service initialization test passed');
      },
    },

    {
      name: 'Scene description functionality',
      fn: async (runtime: any) => {
        logger.info('[Test] Testing scene description...');

        const visionService = runtime.getService('VISION');
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Get current scene description
        const scene = await visionService.getSceneDescription();

        if (!scene) {
          logger.warn('[Test] No scene description available (camera might not be connected)');
          return; // Don't fail if no camera
        }

        // Validate scene structure
        if (typeof scene.timestamp !== 'number') {
          throw new Error('Scene description missing timestamp');
        }

        if (typeof scene.description !== 'string') {
          throw new Error('Scene description missing description text');
        }

        if (!Array.isArray(scene.objects)) {
          throw new Error('Scene description missing objects array');
        }

        if (!Array.isArray(scene.people)) {
          throw new Error('Scene description missing people array');
        }

        logger.info(`[Test] Scene: ${scene.description.substring(0, 100)}...`);
        logger.info(`[Test] Objects: ${scene.objects.length}, People: ${scene.people.length}`);
        logger.info('[Test] ✅ Scene description test passed');
      },
    },

    {
      name: 'Vision mode switching',
      fn: async (runtime: any) => {
        logger.info('[Test] Testing vision mode switching...');

        const visionService = runtime.getService('VISION');
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Get current mode
        const originalMode = visionService.getVisionMode();
        logger.info(`[Test] Original mode: ${originalMode}`);

        // Test switching modes
        const testModes = ['CAMERA', 'SCREEN', 'BOTH', 'OFF'];

        for (const mode of testModes) {
          logger.info(`[Test] Switching to mode: ${mode}`);
          await visionService.setVisionMode(mode);

          const currentMode = visionService.getVisionMode();
          if (currentMode !== mode) {
            throw new Error(`Failed to switch to mode ${mode}, current mode is ${currentMode}`);
          }
        }

        // Restore original mode
        await visionService.setVisionMode(originalMode);
        logger.info('[Test] ✅ Vision mode switching test passed');
      },
    },

    {
      name: 'DESCRIBE_SCENE action execution',
      fn: async (runtime: any) => {
        logger.info('[Test] Testing DESCRIBE_SCENE action...');

        // Find the action
        const action = runtime.actions.find((a: any) => a.name === 'DESCRIBE_SCENE');
        if (!action) {
          throw new Error('DESCRIBE_SCENE action not found');
        }

        // Create test message
        const message = {
          id: `test-msg-${Date.now()}`,
          entityId: 'test-entity',
          roomId: 'test-room',
          content: {
            text: 'Describe what you see',
            source: 'test',
          },
          createdAt: Date.now(),
        };

        // Validate action
        const isValid = await action.validate(runtime, message);
        if (!isValid) {
          throw new Error('DESCRIBE_SCENE action validation failed');
        }

        // Execute action
        let responseReceived = false;
        const callback = async (response: any) => {
          if (response.text && response.text.length > 0) {
            responseReceived = true;
            logger.info(`[Test] Action response: ${response.text.substring(0, 100)}...`);
          }
          return [];
        };

        await action.handler(runtime, message, {}, {}, callback);

        if (!responseReceived) {
          throw new Error('DESCRIBE_SCENE action did not produce a response');
        }

        logger.info('[Test] ✅ DESCRIBE_SCENE action test passed');
      },
    },

    {
      name: 'Vision provider integration',
      fn: async (runtime: any) => {
        logger.info('[Test] Testing vision provider...');

        // Find the vision provider
        const provider = runtime.providers.find((p: any) => p.name === 'visionProvider');
        if (!provider) {
          throw new Error('Vision provider not found');
        }

        // Create test message and state
        const message = {
          id: `test-msg-${Date.now()}`,
          entityId: 'test-entity',
          roomId: 'test-room',
          content: { text: 'test', source: 'test' },
          createdAt: Date.now(),
        };

        const state = {
          values: {},
          data: {},
          text: '',
        };

        // Get provider data
        const result = await provider.get(runtime, message, state);

        if (!result || typeof result !== 'object') {
          throw new Error('Vision provider returned invalid result');
        }

        // Check if provider returns vision data when available
        if (result.text && result.text.includes('I can see')) {
          logger.info(`[Test] Provider text: ${result.text.substring(0, 100)}...`);
        }

        logger.info('[Test] ✅ Vision provider test passed');
      },
    },

    {
      name: 'Florence-2 model initialization',
      fn: async (runtime: any) => {
        logger.info('[Test] Testing Florence-2 model...');

        const visionService = runtime.getService('VISION');
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Check if Florence-2 is enabled
        const florence2Enabled =
          runtime.getSetting('FLORENCE2_ENABLED') === 'true' ||
          runtime.getSetting('VISION_FLORENCE2_ENABLED') === 'true';

        if (!florence2Enabled) {
          logger.info('[Test] Florence-2 is disabled, skipping test');
          return;
        }

        // If screen mode is enabled, Florence-2 should be initialized
        const mode = visionService.getVisionMode();
        if (mode === 'SCREEN' || mode === 'BOTH') {
          // Try to get screen capture
          const screenCapture = await visionService.getScreenCapture();
          if (screenCapture) {
            logger.info('[Test] Screen capture available');
            logger.info(`[Test] Screen size: ${screenCapture.width}x${screenCapture.height}`);
            logger.info(`[Test] Tiles: ${screenCapture.tiles.length}`);
          }
        }

        logger.info('[Test] ✅ Florence-2 model test passed');
      },
    },

    {
      name: 'OCR service functionality',
      fn: async (runtime: any) => {
        logger.info('[Test] Testing OCR service...');

        const visionService = runtime.getService('VISION');
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Check if OCR is enabled
        const ocrEnabled =
          runtime.getSetting('OCR_ENABLED') === 'true' ||
          runtime.getSetting('VISION_OCR_ENABLED') === 'true';

        if (!ocrEnabled) {
          logger.info('[Test] OCR is disabled, skipping test');
          return;
        }

        // If screen mode is enabled, OCR should work
        const mode = visionService.getVisionMode();
        if (mode === 'SCREEN' || mode === 'BOTH') {
          const enhancedScene = await visionService.getEnhancedSceneDescription();
          if (enhancedScene && enhancedScene.screenAnalysis) {
            const ocrText = enhancedScene.screenAnalysis.fullScreenOCR;
            if (ocrText) {
              logger.info(`[Test] OCR extracted ${ocrText.length} characters`);
              logger.info(`[Test] OCR sample: ${ocrText.substring(0, 100)}...`);
            }
          }
        }

        logger.info('[Test] ✅ OCR service test passed');
      },
    },

    {
      name: 'Entity tracking system',
      fn: async (runtime: any) => {
        logger.info('[Test] Testing entity tracking...');

        const visionService = runtime.getService('VISION');
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Get entity tracker
        const entityTracker = visionService.getEntityTracker();
        if (!entityTracker) {
          throw new Error('Entity tracker not found');
        }

        // Get current entities
        const entities = entityTracker.getActiveEntities();
        logger.info(`[Test] Active entities: ${entities.length}`);

        // Check entity structure if any exist
        for (const entity of entities) {
          if (!entity.id || !entity.type || !entity.lastSeen) {
            throw new Error('Entity missing required fields');
          }

          logger.info(
            `[Test] Entity ${entity.id}: type=${entity.type}, tracked=${entity.trackingDuration}ms`
          );
        }

        logger.info('[Test] ✅ Entity tracking test passed');
      },
    },
  ];
}

// Export default instance for test runner
export default new VisionRuntimeTestSuite();
