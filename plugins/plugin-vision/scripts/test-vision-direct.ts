import { VisionService } from '../src/service.js';
import { logger } from '@elizaos/core';

// Mock runtime for testing
const mockRuntime = {
  getSetting: (key: string) => {
    const settings: Record<string, string> = {
      VISION_MODE: 'BOTH',
      VISION_ENABLE_OBJECT_DETECTION: 'true',
      VISION_ENABLE_POSE_DETECTION: 'true',
      VISION_OCR_ENABLED: 'true',
      VISION_FLORENCE2_ENABLED: 'true',
      VISION_PIXEL_CHANGE_THRESHOLD: '30',
      VISION_TF_UPDATE_INTERVAL: '1000',
      VISION_VLM_UPDATE_INTERVAL: '5000',
      VISION_SCREEN_CAPTURE_INTERVAL: '2000',
    };
    return settings[key] || process.env[key];
  },
  useModel: async (type: any, input: any) => {
    console.log(
      '[MockRuntime] Model request:',
      type,
      typeof input === 'string' ? 'image data' : input
    );
    return { description: 'I see a computer screen with a terminal and code editor' };
  },
  logger,
} as any;

async function testVisionService() {
  console.log('🧪 Testing Vision Service directly...\n');

  try {
    // Create and start service
    console.log('📦 Creating Vision Service...');
    const service = await VisionService.start(mockRuntime);

    console.log('✅ Service started successfully!\n');

    // Check service status
    console.log('📊 Service Status:');
    console.log('  - Mode:', service.getVisionMode());
    console.log('  - Camera:', service.getCameraInfo() ? 'Connected' : 'Not connected');
    console.log('  - Active:', service.isActive());
    console.log('');

    // Wait for initial captures
    console.log('⏳ Waiting for initial captures...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Test camera capture
    console.log('\n📷 Testing Camera Capture...');
    const scene = await service.getSceneDescription();
    if (scene) {
      console.log('✅ Scene captured:');
      console.log('  - Description:', scene.description);
      console.log('  - Objects:', scene.objects.length);
      console.log('  - People:', scene.people.length);
      console.log('  - Change:', `${scene.changePercentage?.toFixed(1)}%`);
    } else {
      console.log('❌ No scene description available');
    }

    // Test screen capture
    console.log('\n🖥️ Testing Screen Capture...');
    const screen = await service.getScreenCapture();
    if (screen) {
      console.log('✅ Screen captured:');
      console.log('  - Resolution:', `${screen.width}x${screen.height}`);
      console.log('  - Tiles:', screen.tiles.length);
      console.log('  - Total Tiles:', screen.tiles.length);

      // Check for tile analysis
      const analyzedTiles = screen.tiles.filter((t) => t.analysis);
      console.log('  - Analyzed Tiles:', analyzedTiles.length);

      if (analyzedTiles.length > 0) {
        const tile = analyzedTiles[0];
        console.log('\n  📄 First Analyzed Tile:');
        if (tile.analysis?.florence2) {
          console.log('    - Florence2:', tile.analysis.florence2.caption || 'No caption');
        }
        if (tile.analysis?.ocr) {
          console.log('    - OCR Text:', `${tile.analysis.ocr.fullText.substring(0, 100)}...`);
        }
      }
    } else {
      console.log('❌ No screen capture available');
    }

    // Test enhanced scene
    console.log('\n🎭 Testing Enhanced Scene Description...');
    const enhanced = await service.getEnhancedSceneDescription();
    if (enhanced) {
      console.log('✅ Enhanced scene available');
      if (enhanced.screenAnalysis) {
        console.log(
          '  - Full OCR:',
          enhanced.screenAnalysis.fullScreenOCR ? 'Available' : 'Not available'
        );
        console.log('  - Grid Summary:', enhanced.screenAnalysis.gridSummary);
        console.log('  - Focused App:', enhanced.screenAnalysis.focusedApp || 'Unknown');
      }
    }

    // Test manual capture
    console.log('\n📸 Testing Manual Image Capture...');
    const imageBuffer = await service.captureImage();
    if (imageBuffer) {
      console.log('✅ Image captured:', imageBuffer.length, 'bytes');
    } else {
      console.log('❌ Could not capture image');
    }

    // Monitor for changes
    console.log('\n👀 Monitoring for changes (10 seconds)...\n');
    let changeCount = 0;

    const monitor = setInterval(async () => {
      const currentScene = await service.getSceneDescription();
      if (currentScene && currentScene.sceneChanged) {
        changeCount++;
        console.log(
          `[${new Date().toLocaleTimeString()}] Change #${changeCount}:`,
          `${currentScene.description.substring(0, 80)}...`
        );
      }
    }, 1000);

    // Stop after 10 seconds
    setTimeout(async () => {
      clearInterval(monitor);
      console.log(`\n📊 Summary: Detected ${changeCount} scene changes in 10 seconds`);

      // Clean up
      console.log('\n🧹 Stopping service...');
      await service.stop();
      console.log('✅ Service stopped');

      process.exit(0);
    }, 10000);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the test
testVisionService().catch(console.error);
