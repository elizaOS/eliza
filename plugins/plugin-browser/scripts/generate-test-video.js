#!/usr/bin/env node

/**
 * Generate a simple test video for TikTok upload testing
 * This creates a 5-second MP4 video with colored frames
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if ffmpeg is installed
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
} catch (error) {
  console.error('Error: ffmpeg is not installed. Please install ffmpeg first:');
  console.error('  macOS: brew install ffmpeg');
  console.error('  Ubuntu: sudo apt-get install ffmpeg');
  console.error('  Windows: Download from https://ffmpeg.org/download.html');
  process.exit(1);
}

const outputDir = path.join(__dirname, '..', 'test-videos');
const outputPath = path.join(outputDir, 'test-video.mp4');

// Create output directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('Generating test video...');

// Generate a 5-second test video with colored bars and text
const ffmpegCommand = `ffmpeg -y \
  -f lavfi -i "testsrc=duration=5:size=720x1280:rate=30" \
  -f lavfi -i "sine=frequency=1000:duration=5" \
  -vf "drawtext=text='ElizaOS Test Video':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0,5)'" \
  -c:v libx264 -pix_fmt yuv420p \
  -c:a aac \
  "${outputPath}"`;

try {
  execSync(ffmpegCommand, { stdio: 'inherit' });
  console.log('\n✅ Test video created successfully!');
  console.log(`📍 Location: ${outputPath}`);
  console.log('\nTo use this video for testing, add to your .env file:');
  console.log(`TIKTOK_TEST_VIDEO_PATH=${outputPath}`);
} catch (error) {
  console.error('Error generating test video:', error.message);
  process.exit(1);
}
