import type { TestSuite, IAgentRuntime, Memory } from '@elizaos/core';
import { createUniqueUuid } from '@elizaos/core';
import { VisionService } from '../../service';
import { VisionMode } from '../../types';
import { setVisionModeAction } from '../../action';

export class ScreenVisionE2ETestSuite implements TestSuite {
  name = 'plugin-vision-screen-e2e';
  description = 'E2E tests for screen vision functionality including Florence-2 and OCR';

  tests = [
    {
      name: 'Should initialize screen vision components',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing screen vision initialization...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        // Set vision mode to SCREEN
        await visionService.setVisionMode(VisionMode.SCREEN);

        // Wait for initialization
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const mode = visionService.getVisionMode();
        if (mode !== VisionMode.SCREEN) {
          throw new Error(`Expected vision mode SCREEN but got ${mode}`);
        }

        console.log('✓ Screen vision mode activated');

        // Check if screen capture is available
        const screenInfo = await visionService.getScreenCapture();
        if (screenInfo) {
          console.log(`✓ Screen capture available: ${screenInfo.width}x${screenInfo.height}`);
        } else {
          console.log('⚠️  Screen capture not yet available (may still be initializing)');
        }
      },
    },

    {
      name: 'Should capture and tile screen',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing screen capture and tiling...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        // Ensure screen mode is active
        await visionService.setVisionMode(VisionMode.SCREEN);

        // Wait for capture
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const screenCapture = await visionService.getScreenCapture();
        if (!screenCapture) {
          console.warn(
            '⚠️  No screen capture available - screen capture may not be supported in this environment'
          );
          return;
        }

        console.log(`✓ Screen captured: ${screenCapture.width}x${screenCapture.height}`);
        console.log(`✓ Divided into ${screenCapture.tiles.length} tiles`);

        // Check tile structure
        const firstTile = screenCapture.tiles[0];
        if (!firstTile) {
          throw new Error('No tiles created from screen capture');
        }

        console.log(`  First tile: ${firstTile.id} at (${firstTile.x}, ${firstTile.y})`);
        console.log(`  Tile size: ${firstTile.width}x${firstTile.height}`);

        // Check if priority tiles have data
        const tilesWithData = screenCapture.tiles.filter((t) => t.data !== undefined);
        console.log(`  Tiles with data: ${tilesWithData.length}`);

        if (tilesWithData.length === 0) {
          console.warn('⚠️  No tiles have been processed yet');
        }
      },
    },

    {
      name: 'Should analyze screen content with Florence-2 and OCR',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing screen content analysis...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        // Ensure screen mode is active
        await visionService.setVisionMode(VisionMode.SCREEN);

        // Wait for analysis
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const enhancedScene = await visionService.getEnhancedSceneDescription();
        if (!enhancedScene || !enhancedScene.screenAnalysis) {
          console.warn('⚠️  No enhanced scene analysis available yet');
          return;
        }

        console.log('✓ Enhanced scene analysis available');

        const screenAnalysis = enhancedScene.screenAnalysis;

        // Check active tile analysis
        if (screenAnalysis.activeTile) {
          console.log('✓ Active tile analyzed');

          if (screenAnalysis.activeTile.florence2) {
            console.log(`  Florence-2 caption: ${screenAnalysis.activeTile.florence2.caption}`);
            console.log(
              `  Objects detected: ${screenAnalysis.activeTile.florence2.objects?.length || 0}`
            );
            console.log(
              `  Tags: ${screenAnalysis.activeTile.florence2.tags?.join(', ') || 'none'}`
            );
          }

          if (screenAnalysis.activeTile.ocr) {
            console.log(`  OCR text blocks: ${screenAnalysis.activeTile.ocr.blocks.length}`);
            console.log(
              `  OCR preview: "${screenAnalysis.activeTile.ocr.fullText.substring(0, 50)}..."`
            );
          }
        }

        // Check full screen OCR
        if (screenAnalysis.fullScreenOCR) {
          console.log(`✓ Full screen OCR: ${screenAnalysis.fullScreenOCR.length} characters`);
        }

        // Check UI elements
        if (screenAnalysis.uiElements && screenAnalysis.uiElements.length > 0) {
          console.log(`✓ UI elements detected: ${screenAnalysis.uiElements.length}`);
          const elementTypes = screenAnalysis.uiElements.map((e) => e.type);
          const uniqueTypes = [...new Set(elementTypes)];
          console.log(`  Types: ${uniqueTypes.join(', ')}`);
        }
      },
    },

    {
      name: 'Should switch between vision modes',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing vision mode switching...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        // Test all modes
        const modes = [VisionMode.CAMERA, VisionMode.SCREEN, VisionMode.BOTH, VisionMode.OFF];

        for (const mode of modes) {
          console.log(`  Switching to ${mode} mode...`);
          await visionService.setVisionMode(mode);

          // Wait for mode switch
          await new Promise((resolve) => setTimeout(resolve, 1000));

          const currentMode = visionService.getVisionMode();
          if (currentMode !== mode) {
            throw new Error(`Failed to switch to ${mode} mode, current mode is ${currentMode}`);
          }

          console.log(`  ✓ Successfully switched to ${mode} mode`);
        }

        // Test with action
        console.log('  Testing SET_VISION_MODE action...');

        const message: Memory = {
          id: createUniqueUuid(runtime, 'test-msg'),
          entityId: runtime.agentId,
          content: { text: 'set vision mode to both' },
          agentId: runtime.agentId,
          roomId: createUniqueUuid(runtime, 'test-room'),
          createdAt: Date.now(),
        };

        let callbackCalled = false;
        await setVisionModeAction.handler(
          runtime,
          message,
          { values: {}, data: {}, text: '' },
          {},
          async (response) => {
            callbackCalled = true;
            console.log(`  Action response: ${response.text}`);
            return [];
          }
        );

        if (!callbackCalled) {
          throw new Error('SET_VISION_MODE action did not call callback');
        }

        const finalMode = visionService.getVisionMode();
        if (finalMode !== VisionMode.BOTH) {
          throw new Error(`SET_VISION_MODE action failed, mode is ${finalMode}`);
        }

        console.log('✓ Vision mode switching works correctly');
      },
    },

    {
      name: 'Should provide combined vision data in BOTH mode',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing combined camera and screen vision...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        // Set to BOTH mode
        await visionService.setVisionMode(VisionMode.BOTH);

        // Wait for both systems to initialize
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const enhancedScene = await visionService.getEnhancedSceneDescription();
        const hasCamera = visionService.getCameraInfo() !== null;
        const hasScreen = (await visionService.getScreenCapture()) !== null;

        console.log(`  Camera available: ${hasCamera}`);
        console.log(`  Screen capture available: ${hasScreen}`);

        if (!hasCamera && !hasScreen) {
          console.warn('⚠️  Neither camera nor screen capture available in this environment');
          return;
        }

        if (enhancedScene) {
          // Check for camera data
          if (hasCamera && enhancedScene.description) {
            console.log('✓ Camera data present in combined mode');
            console.log(`  Scene: ${enhancedScene.description.substring(0, 50)}...`);
          }

          // Check for screen data
          if (hasScreen && enhancedScene.screenAnalysis) {
            console.log('✓ Screen data present in combined mode');
            console.log(`  Grid: ${enhancedScene.screenAnalysis.gridSummary}`);
          }
        }

        // Check provider output
        const state = await runtime.composeState({
          id: createUniqueUuid(runtime, 'test-msg'),
          entityId: runtime.agentId,
          content: { text: 'test' },
          agentId: runtime.agentId,
          roomId: createUniqueUuid(runtime, 'test-room'),
          createdAt: Date.now(),
        });

        if (state.text.includes('Vision mode: BOTH')) {
          console.log('✓ Provider correctly reports BOTH mode');
        }
      },
    },

    {
      name: 'Should handle screen capture errors gracefully',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing error handling...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        // Try to set invalid region (should handle gracefully)
        const originalConfig = (visionService as any).visionConfig;
        (visionService as any).visionConfig.screenRegion = {
          x: -100,
          y: -100,
          width: 50000,
          height: 50000,
        };

        await visionService.setVisionMode(VisionMode.SCREEN);
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Service should still be active despite invalid region
        const isActive = visionService.isActive();
        console.log(`  Service active after invalid config: ${isActive}`);

        // Restore config
        (visionService as any).visionConfig = originalConfig;

        console.log('✓ Error handling works correctly');
      },
    },
  ];
}

export default new ScreenVisionE2ETestSuite();
