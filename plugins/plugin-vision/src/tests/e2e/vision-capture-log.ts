import type { TestSuite, IAgentRuntime } from '@elizaos/core';
import { VisionService } from '../../service';
import * as fs from 'fs/promises';
import * as path from 'path';

export class VisionCaptureLogTestSuite implements TestSuite {
  name = 'plugin-vision-capture-log';
  description = 'Captures 30 seconds of vision data and saves to logs for analysis';

  tests = [
    {
      name: 'Should capture and log 30 seconds of vision data',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Starting 30-second vision capture test...');

        const visionService = runtime.getService<VisionService>('VISION');
        if (!visionService) {
          throw new Error('Vision service not available');
        }

        if (!visionService.isActive()) {
          console.warn('⚠️  Vision service not active - no camera available');
          console.log('   Cannot capture vision data without a camera');
          return;
        }

        // Create logs directory if it doesn't exist
        const logsDir = path.join(process.cwd(), 'logs');
        const sessionDir = path.join(
          logsDir,
          `vision-capture-${new Date().toISOString().replace(/[:.]/g, '-')}`
        );
        await fs.mkdir(sessionDir, { recursive: true });

        console.log(`✓ Created log directory: ${sessionDir}`);

        // Initialize capture data
        const captureData = {
          sessionId: `vision-capture-${Date.now()}`,
          startTime: new Date().toISOString(),
          endTime: '',
          runtime: {
            agentId: runtime.agentId,
            characterName: runtime.character.name,
          },
          camera: visionService.getCameraInfo(),
          captures: [] as any[],
          statistics: {
            totalFrames: 0,
            totalSceneChanges: 0,
            totalObjectsDetected: 0,
            totalPeopleDetected: 0,
            averageChangePercentage: 0,
            objectTypeCounts: {} as Record<string, number>,
            poseCounts: {} as Record<string, number>,
          },
        };

        // Capture interval - every 500ms for 30 seconds = 60 captures
        const captureInterval = 500;
        const totalDuration = 30000;
        const expectedCaptures = totalDuration / captureInterval;

        console.log(
          `📸 Capturing vision data every ${captureInterval}ms for ${totalDuration / 1000} seconds...`
        );
        console.log(`   Expected captures: ${expectedCaptures}`);

        let captureCount = 0;
        let totalChangePercentage = 0;
        let lastLoggedProgress = 0;

        const startTime = Date.now();

        while (Date.now() - startTime < totalDuration) {
          const captureStartTime = Date.now();

          try {
            // Get current scene description
            const scene = await visionService.getSceneDescription();
            const frame = await visionService.getCurrentFrame();

            // Capture image as base64
            const imageBuffer = await visionService.captureImage();
            let imageBase64: string | null = null;
            if (imageBuffer) {
              imageBase64 = imageBuffer.toString('base64');
            }

            const capture = {
              index: captureCount,
              timestamp: new Date().toISOString(),
              timestampMs: Date.now(),
              elapsedMs: Date.now() - startTime,
              scene: scene
                ? {
                    description: scene.description,
                    changePercentage: scene.changePercentage,
                    sceneChanged: scene.sceneChanged,
                    objectCount: scene.objects.length,
                    peopleCount: scene.people.length,
                    objects: scene.objects,
                    people: scene.people,
                  }
                : null,
              frame: frame
                ? {
                    width: frame.width,
                    height: frame.height,
                    format: frame.format,
                    timestamp: frame.timestamp,
                  }
                : null,
              imageBase64: imageBase64 ?? null,
            };

            captureData.captures.push(capture);

            // Save full image separately
            if (imageBase64) {
              const imagePath = path.join(
                sessionDir,
                `capture-${String(captureCount).padStart(3, '0')}.jpg`
              );
              await fs.writeFile(imagePath, Buffer.from(imageBase64, 'base64'));
            }

            // Update statistics
            if (scene) {
              captureData.statistics.totalFrames++;
              if (scene.sceneChanged) {
                captureData.statistics.totalSceneChanges++;
              }
              if (scene.changePercentage) {
                totalChangePercentage += scene.changePercentage;
              }
              captureData.statistics.totalObjectsDetected += scene.objects.length;
              captureData.statistics.totalPeopleDetected += scene.people.length;

              // Count object types
              for (const obj of scene.objects) {
                captureData.statistics.objectTypeCounts[obj.type] =
                  (captureData.statistics.objectTypeCounts[obj.type] || 0) + 1;
              }

              // Count poses
              for (const person of scene.people) {
                captureData.statistics.poseCounts[person.pose] =
                  (captureData.statistics.poseCounts[person.pose] || 0) + 1;
              }

              // Save detailed scene log
              const sceneLogPath = path.join(
                sessionDir,
                `scene-${String(captureCount).padStart(3, '0')}.json`
              );
              await fs.writeFile(
                sceneLogPath,
                JSON.stringify(
                  {
                    capture: captureCount,
                    timestamp: capture.timestamp,
                    scene,
                    frame: frame
                      ? {
                          width: frame.width,
                          height: frame.height,
                          format: frame.format,
                        }
                      : null,
                  },
                  null,
                  2
                )
              );
            }

            captureCount++;

            // Progress logging every 5 seconds
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            if (elapsedSeconds > lastLoggedProgress && elapsedSeconds % 5 === 0) {
              lastLoggedProgress = elapsedSeconds;
              const progress = (elapsedSeconds / 30) * 100;
              console.log(
                `  Progress: ${progress.toFixed(0)}% (${elapsedSeconds}/30s) - Captured ${captureCount} frames`
              );

              if (scene) {
                console.log(`    Last scene: "${scene.description.substring(0, 60)}..."`);
                if (scene.objects.length > 0 || scene.people.length > 0) {
                  console.log(
                    `    Detected: ${scene.objects.length} objects, ${scene.people.length} people`
                  );
                }
              }
            }
          } catch (error) {
            console.error(`  Error in capture ${captureCount}:`, error);
            captureData.captures.push({
              index: captureCount,
              timestamp: new Date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            });
            captureCount++;
          }

          // Wait for next capture interval
          const captureEndTime = Date.now();
          const captureDuration = captureEndTime - captureStartTime;
          const waitTime = Math.max(0, captureInterval - captureDuration);

          if (waitTime > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
        }

        // Finalize statistics
        captureData.endTime = new Date().toISOString();
        captureData.statistics.averageChangePercentage =
          captureData.statistics.totalFrames > 0
            ? totalChangePercentage / captureData.statistics.totalFrames
            : 0;

        // Save main capture log
        const mainLogPath = path.join(sessionDir, 'vision-capture-summary.json');
        await fs.writeFile(mainLogPath, JSON.stringify(captureData, null, 2));

        // Generate markdown report
        const reportPath = path.join(sessionDir, 'vision-capture-report.md');
        const report = `# Vision Capture Report

## Session Information
- **Session ID**: ${captureData.sessionId}
- **Start Time**: ${captureData.startTime}
- **End Time**: ${captureData.endTime}
- **Duration**: 30 seconds
- **Agent**: ${captureData.runtime.characterName} (${captureData.runtime.agentId})

## Camera Information
- **Name**: ${captureData.camera?.name || 'Unknown'}
- **ID**: ${captureData.camera?.id || 'Unknown'}

## Capture Statistics
- **Total Frames Captured**: ${captureCount}
- **Total Scene Changes**: ${captureData.statistics.totalSceneChanges}
- **Average Change Percentage**: ${captureData.statistics.averageChangePercentage.toFixed(2)}%
- **Total Objects Detected**: ${captureData.statistics.totalObjectsDetected}
- **Total People Detected**: ${captureData.statistics.totalPeopleDetected}

## Object Type Distribution
${
  Object.entries(captureData.statistics.objectTypeCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `- **${type}**: ${count} detections`)
    .join('\n') || '- No objects detected'
}

## Pose Distribution
${
  Object.entries(captureData.statistics.poseCounts)
    .map(([pose, count]) => `- **${pose}**: ${count} detections`)
    .join('\n') || '- No people detected'
}

## Sample Scene Descriptions
${captureData.captures
  .filter((c) => c.scene?.description)
  .slice(0, 5)
  .map(
    (c, _i) => `### Capture ${c.index} (${c.elapsedMs}ms)
"${c.scene.description}"
- Change: ${c.scene.changePercentage?.toFixed(1)}%
- Objects: ${c.scene.objectCount}
- People: ${c.scene.peopleCount}`
  )
  .join('\n\n')}

## Files Generated
- \`vision-capture-summary.json\` - Complete capture data
- \`vision-capture-report.md\` - This report
- \`capture-XXX.jpg\` - Individual captured images
- \`scene-XXX.json\` - Detailed scene data for each capture
`;

        await fs.writeFile(reportPath, report);

        console.log('\n✅ Vision capture test completed!');
        console.log('📊 Capture Summary:');
        console.log(`   - Total frames: ${captureCount}`);
        console.log(`   - Scene changes: ${captureData.statistics.totalSceneChanges}`);
        console.log(
          `   - Average change: ${captureData.statistics.averageChangePercentage.toFixed(2)}%`
        );
        console.log(`   - Objects detected: ${captureData.statistics.totalObjectsDetected}`);
        console.log(`   - People detected: ${captureData.statistics.totalPeopleDetected}`);
        console.log(`\n📁 Results saved to: ${sessionDir}`);
        console.log('   - Summary: vision-capture-summary.json');
        console.log('   - Report: vision-capture-report.md');
        console.log('   - Images: capture-XXX.jpg');
        console.log('   - Scene data: scene-XXX.json');

        console.log('✅ Vision capture log test PASSED');
      },
    },
  ];
}

export default new VisionCaptureLogTestSuite();
