#!/usr/bin/env node
/**
 * View image tool
 * Displays an image file as a base64-encoded markdown image
 * Converted from tools/image_tools/bin/view_image
 */

import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';

const VALID_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg', 
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml'
]);

function getMimeType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return null;
  }
}

function viewImage(imagePath: string): void {
  // Check if file exists
  if (!fs.existsSync(imagePath)) {
    console.error(`Error: File '${imagePath}' does not exist`);
    process.exit(1);
  }

  // Check if it's a file
  const stats = fs.statSync(imagePath);
  if (!stats.isFile()) {
    console.error(`Error: '${imagePath}' is not a file`);
    process.exit(1);
  }

  // Get MIME type
  const mimeType = getMimeType(imagePath);
  if (!mimeType || !VALID_MIME_TYPES.has(mimeType)) {
    console.error(`Error: Unsupported image type: ${mimeType}. Valid types are: ${Array.from(VALID_MIME_TYPES).join(', ')}`);
    process.exit(1);
  }

  try {
    // Read file and convert to base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');
    
    // Output markdown image syntax
    console.log(`![${path.basename(imagePath)}](data:${mimeType};base64,${base64})`);
  } catch (error) {
    console.error(`Error processing image: ${error}`);
    process.exit(1);
  }
}

// CLI if run directly
// CLI setup
function setupCLI() {
  program
    .name('view-image')
    .description('View an image file as a base64-encoded markdown image')
    .version('1.0.0')
    .argument('<image-file>', 'Path to the image file to view')
    .action((imagePath) => {
      viewImage(imagePath);
    });

  program.parse(process.argv);
}

// Run CLI if called directly or from bin script
if (require.main === module || require.main?.filename?.endsWith('/bin/view_image')) {
  setupCLI();
}

export { viewImage };
