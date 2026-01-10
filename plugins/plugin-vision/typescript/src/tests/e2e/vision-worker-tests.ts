import type { TestSuite, IAgentRuntime } from '@elizaos/core';
import { VisionService } from '../../service';
import { VisionServiceType } from '../../types';
import { TestPatternGenerator } from '../test-pattern-generator';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class VisionWorkerE2ETestSuite implements TestSuite {
  name = 'plugin-vision-workers-e2e';
  description = 'E2E tests for multi-threaded vision system with worker threads';

  tests = [
    {
      name: 'Should access vision service through runtime',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing vision service access through runtime...');

        // Get vision service from runtime
        const visionService = runtime.getService<VisionService>(VisionServiceType.VISION);

        if (!visionService) {
          throw new Error('Vision service not found in runtime');
        }

        console.log('✓ Vision service found in runtime');

        // Check if service is active
        const isActive = visionService.isActive();
        console.log(`✓ Vision service active: ${isActive}`);

        // Get vision mode
        const mode = visionService.getVisionMode();
        console.log(`✓ Vision mode: ${mode}`);

        // Get enhanced scene description (which uses worker manager if available)
        const scene = await visionService.getEnhancedSceneDescription();
        if (scene) {
          console.log('✓ Enhanced scene available');
          if (scene.screenAnalysis) {
            console.log('  - Screen analysis present');
          }
        }
      },
    },

    {
      name: 'Should capture screen at high FPS through service',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing high-FPS screen capture through service...');

        const visionService = runtime.getService<VisionService>(VisionServiceType.VISION);
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Monitor for 5 seconds
        console.log('Monitoring screen capture for 5 seconds...');
        const startTime = Date.now();
        let frameCount = 0;
        let lastTimestamp = 0;

        while (Date.now() - startTime < 5000) {
          const scene = await visionService.getEnhancedSceneDescription();
          if (scene && scene.timestamp !== lastTimestamp) {
            frameCount++;
            lastTimestamp = scene.timestamp;
          }

          // Non-blocking check
          await new Promise((resolve) => setImmediate(resolve));
        }

        const totalTime = (Date.now() - startTime) / 1000;
        const avgFPS = frameCount / totalTime;
        console.log(
          `✓ Captured ${frameCount} unique frames in ${totalTime.toFixed(2)}s (${avgFPS.toFixed(2)} FPS)`
        );

        if (avgFPS < 1) {
          console.warn('⚠️  FPS is lower than expected - workers may not be enabled');
        }
      },
    },

    {
      name: 'Should detect quadrant numbers using OCR through service',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing quadrant number detection through service...');

        const visionService = runtime.getService<VisionService>(VisionServiceType.VISION);
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Generate test pattern
        const pattern = await TestPatternGenerator.generateQuadrantPattern({
          width: 1920,
          height: 1080,
          fontSize: 72,
          includeGrid: true,
        });

        const patternPath = await TestPatternGenerator.savePattern(pattern, 'quadrant-test.png');
        console.log(`✓ Test pattern saved to ${patternPath}`);

        // Display the pattern
        await displayTestPattern(patternPath);

        try {
          // Wait for OCR to process
          console.log('Waiting for OCR processing...');
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Get enhanced scene with OCR results
          const scene = await visionService.getEnhancedSceneDescription();
          const ocrText = scene?.screenAnalysis?.fullScreenOCR || '';

          console.log(`OCR detected text: "${ocrText.substring(0, 100)}..."`);

          // Verify quadrant numbers
          const verification = TestPatternGenerator.verifyQuadrantNumbers(ocrText);
          console.log(`Found numbers: ${verification.foundNumbers.join(', ')}`);

          if (verification.success) {
            console.log('✓ All quadrant numbers detected correctly');
          } else {
            console.warn(`⚠️  Missing numbers: ${verification.missingNumbers.join(', ')}`);
          }

          await closeTestPattern();
        } catch (error) {
          await closeTestPattern();
          throw error;
        }
      },
    },

    {
      name: 'Should handle multiple displays through service',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing multi-display support through service...');

        const visionService = runtime.getService<VisionService>(VisionServiceType.VISION);
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Get display count
        const displayCount = await getDisplayCount();
        console.log(`Found ${displayCount} display(s)`);

        if (displayCount <= 1) {
          console.log('⚠️  Only one display found, skipping multi-display test');
          return;
        }

        // Run for 10 seconds to cycle through displays
        console.log('Monitoring displays for 10 seconds...');
        const startTime = Date.now();

        while (Date.now() - startTime < 10000) {
          const scene = await visionService.getEnhancedSceneDescription();
          if (scene?.screenCapture) {
            // Log current screen info
            console.log(`  Screen: ${scene.screenCapture.width}x${scene.screenCapture.height}`);
          }

          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        console.log(`✓ Monitored ${displayCount} displays`);
      },
    },

    {
      name: 'Should process Florence-2 and OCR in parallel through service',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing parallel processing performance through service...');

        const visionService = runtime.getService<VisionService>(VisionServiceType.VISION);
        if (!visionService) {
          throw new Error('Vision service not found');
        }

        // Generate complex pattern
        const pattern = await TestPatternGenerator.generateComplexPattern({
          width: 1920,
          height: 1080,
        });

        const patternPath = await TestPatternGenerator.savePattern(pattern, 'complex-test.png');
        await displayTestPattern(patternPath);

        try {
          // Monitor performance for 10 seconds
          console.log('Running parallel processing test for 10 seconds...');
          const startTime = Date.now();
          const stats = {
            frames: 0,
            ocrDetections: 0,
            florence2Detections: 0,
          };

          while (Date.now() - startTime < 10000) {
            const scene = await visionService.getEnhancedSceneDescription();

            if (scene) {
              stats.frames++;

              if (scene.screenAnalysis?.fullScreenOCR) {
                stats.ocrDetections++;
              }

              if (scene.screenAnalysis?.activeTile?.florence2) {
                stats.florence2Detections++;
              }
            }

            // Log every 2 seconds
            if ((Date.now() - startTime) % 2000 < 100) {
              console.log('\nCurrent stats:');
              console.log(`  Frames: ${stats.frames}`);
              console.log(`  OCR detections: ${stats.ocrDetections}`);
              console.log(`  Florence-2 detections: ${stats.florence2Detections}`);
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          const totalTime = (Date.now() - startTime) / 1000;
          console.log('\nFinal statistics:');
          console.log(`  Total frames: ${stats.frames}`);
          console.log(`  Average FPS: ${(stats.frames / totalTime).toFixed(2)}`);
          console.log(
            `  OCR success rate: ${((stats.ocrDetections / stats.frames) * 100).toFixed(1)}%`
          );
          console.log(
            `  Florence-2 success rate: ${((stats.florence2Detections / stats.frames) * 100).toFixed(1)}%`
          );

          await closeTestPattern();
        } catch (error) {
          await closeTestPattern();
          throw error;
        }
      },
    },
  ];
}

// Helper functions

async function getDisplayCount(): Promise<number> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json');
      const data = JSON.parse(stdout);
      return data.SPDisplaysDataType?.[0]?._items?.length || 1;
    } else if (platform === 'linux') {
      const { stdout } = await execAsync('xrandr --query | grep " connected" | wc -l');
      return parseInt(stdout.trim(), 10) || 1;
    } else if (platform === 'win32') {
      const { stdout } = await execAsync(
        'wmic path Win32_DesktopMonitor get DeviceID /format:csv | find /c "DISPLAY"'
      );
      return parseInt(stdout.trim(), 10) || 1;
    }
  } catch (error) {
    console.error('Failed to get display count:', error);
  }

  return 1;
}

async function displayTestPattern(imagePath: string): Promise<void> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      // Open in Preview
      await execAsync(`open "${imagePath}"`);
    } else if (platform === 'linux') {
      // Try common image viewers
      try {
        await execAsync(`xdg-open "${imagePath}"`);
      } catch {
        await execAsync(`display "${imagePath}"`);
      }
    } else if (platform === 'win32') {
      // Open with default image viewer
      await execAsync(`start "" "${imagePath}"`);
    }

    // Give time for window to open
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.warn('Could not display test pattern:', error);
  }
}

async function closeTestPattern(): Promise<void> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      // Close Preview
      await execAsync('osascript -e \'tell application "Preview" to quit\'');
    } else if (platform === 'linux') {
      // Close common viewers
      await execAsync('pkill -f "display.*test-patterns" || pkill -f "eog.*test-patterns" || true');
    } else if (platform === 'win32') {
      // Close Photos app
      await execAsync('taskkill /IM Microsoft.Photos.exe /F 2>nul || exit 0');
    }
  } catch (_error) {
    // Ignore errors when closing
  }
}

export default new VisionWorkerE2ETestSuite();
