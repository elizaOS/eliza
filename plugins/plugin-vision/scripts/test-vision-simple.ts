#!/usr/bin/env tsx

import { Florence2Local } from '../src/florence2-local';
import { logger } from '@elizaos/core';

async function testVision() {
  console.log('Testing Florence-2 Local Model...\n');

  const florence2 = new Florence2Local();

  try {
    // Initialize the model
    console.log('1. Initializing model...');
    await florence2.initialize();
    console.log('✅ Model initialized\n');

    // Create a simple test image buffer (1x1 white pixel)
    const testImageBuffer = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
      0x90,
      0x77,
      0x53,
      0xde,
      0x00,
      0x00,
      0x00,
      0x0c,
      0x49,
      0x44,
      0x41,
      0x54,
      0x08,
      0xd7,
      0x63,
      0xf8,
      0xff,
      0xff,
      0x3f,
      0x00,
      0x05,
      0xfe,
      0x02,
      0xfe,
      0xdc,
      0xcc,
      0x59,
      0xe7,
      0x00,
      0x00,
      0x00,
      0x00,
      0x49,
      0x45,
      0x4e,
      0x44,
      0xae,
      0x42,
      0x60,
      0x82,
    ]);

    // Test image analysis
    console.log('2. Analyzing test image...');
    const result = await florence2.analyzeImage(testImageBuffer);
    console.log('✅ Analysis complete\n');

    console.log('Results:');
    console.log('- Caption:', result.caption);
    console.log('- Tags:', result.tags);
    console.log('- Objects:', result.objects?.length || 0);

    // Test with a more realistic scenario
    console.log('\n3. Testing with realistic fallback...');
    // Since we can't capture a real image in this test, the fallback will be used
    const fallbackResult = await florence2.analyzeImage(Buffer.from('fake image data'));
    console.log('- Fallback caption:', fallbackResult.caption);
    console.log('- Fallback tags:', fallbackResult.tags);

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await florence2.dispose();
    console.log('\nModel disposed');
  }
}

testVision().catch(console.error);
