import { logger } from '@elizaos/core';

/**
 * Open URL in default browser
 * Handles cross-platform browser opening using Bun.spawn
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    const platform = process.platform;

    let command: string;
    let args: string[];

    switch (platform) {
      case 'darwin': // macOS
        command = 'open';
        args = [url];
        break;
      case 'win32': // Windows
        command = 'cmd';
        args = ['/c', 'start', '', url];
        break;
      default: // Linux and others
        // Try xdg-open first (most common on Linux)
        command = 'xdg-open';
        args = [url];
        break;
    }

    // Use Bun.spawn to open browser (non-blocking)
    // We don't need to wait for the browser process - just fire and forget
    Bun.spawn([command, ...args], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    });

    return true;
  } catch (error) {
    logger.error('Failed to open browser:', error instanceof Error ? error.message : String(error));
    return false;
  }
}
