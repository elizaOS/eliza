import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Open URL in default browser
 * Handles cross-platform browser opening
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    const platform = process.platform;

    let command: string;

    switch (platform) {
      case 'darwin': // macOS
        command = `open "${url}"`;
        break;
      case 'win32': // Windows
        command = `start "" "${url}"`;
        break;
      default: // Linux and others
        // Try xdg-open first (most common on Linux)
        command = `xdg-open "${url}" || sensible-browser "${url}" || x-www-browser "${url}"`;
        break;
    }

    await execAsync(command);
    return true;
  } catch (error) {
    console.debug('Failed to open browser:', error);
    return false;
  }
}
