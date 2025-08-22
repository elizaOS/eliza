import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Copies the client dist files to the server dist directory
 */
async function copyClientDist() {
  try {
    console.log('Copying client dist files to server...');

    // Resolve paths relative to the server package
    const serverRoot = resolve(__dirname, '../..');
    const clientDistPath = resolve(serverRoot, '../client/dist');
    const serverDistPath = resolve(serverRoot, 'dist');
    const targetPath = join(serverDistPath, 'client');

    // Check if client dist exists
    if (!existsSync(clientDistPath)) {
      console.error('Client dist not found at:', clientDistPath);
      console.error('Please build the client package first: cd packages/client && bun run build');
      process.exit(1);
    }

    // Create server dist directory if it doesn't exist
    if (!existsSync(serverDistPath)) {
      mkdirSync(serverDistPath, { recursive: true });
    }

    // Remove existing client files in server dist if they exist
    if (existsSync(targetPath)) {
      console.log('Removing existing client files...');
      rmSync(targetPath, { recursive: true, force: true });
    }

    // Copy client dist to server dist/client
    console.log(`Copying from ${clientDistPath} to ${targetPath}...`);
    cpSync(clientDistPath, targetPath, { recursive: true });

    console.log('✓ Client dist files copied successfully to:', targetPath);
  } catch (error) {
    console.error('Error copying client dist files:', error);
    process.exit(1);
  }
}

// Run the script
copyClientDist().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
