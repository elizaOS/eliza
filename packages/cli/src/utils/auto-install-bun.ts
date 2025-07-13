import { logger } from '@elizaos/core';
import { bunExec, bunExecInherit, commandExists } from './bun-exec';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Constants
const INSTALLATION_VERIFICATION_DELAY_MS = 2000; // 2 seconds delay to allow installation to complete

/**
 * Updates the PATH environment variable to include Bun's installation directory
 */
function updatePathForBun(): void {
  const home = homedir();
  const bunBinPath = join(home, '.bun', 'bin');

  // Check if the PATH already includes the Bun directory
  const currentPath = process.env.PATH || '';
  const pathSeparator = process.platform === 'win32' ? ';' : ':';

  // Split PATH into individual directories and check for exact match
  const pathDirs = currentPath.split(pathSeparator);
  const bunBinPathNormalized = bunBinPath.replace(/[/\\]+$/, ''); // Remove trailing slashes

  const isInPath = pathDirs.some((dir) => {
    const dirNormalized = dir.replace(/[/\\]+$/, ''); // Remove trailing slashes
    return dirNormalized === bunBinPathNormalized;
  });

  if (!isInPath) {
    // Prepend Bun's bin directory to PATH
    process.env.PATH = `${bunBinPath}${pathSeparator}${currentPath}`;
    logger.debug(`Added ${bunBinPath} to PATH for current process`);
  } else {
    logger.debug(`${bunBinPath} is already in PATH`);
  }
}

/**
 * Checks if Bun is already installed
 */
async function isBunInstalled(): Promise<boolean> {
  try {
    // First check if the command exists using commandExists
    // This avoids throwing when bun is not found
    const exists = await commandExists('bun');
    if (!exists) {
      return false;
    }

    // If it exists, verify it actually works by getting version
    const result = await bunExec('bun', ['--version'], { stdio: 'ignore' });
    return result.success;
  } catch (error) {
    // Handle any unexpected errors
    logger.debug('Error checking if Bun is installed:', error);
    return false;
  }
}

/**
 * Attempts to automatically install Bun based on the platform
 */
export async function autoInstallBun(): Promise<boolean> {
  // Check if Bun is already installed
  if (await isBunInstalled()) {
    logger.info('Bun is already installed.');
    return true;
  }

  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows installation
      await bunExecInherit('powershell', ['-c', 'irm bun.sh/install.ps1 | iex']);
    } else {
      // macOS and Linux installation
      await bunExecInherit('sh', ['-c', 'curl -fsSL https://bun.sh/install | bash']);
    }

    logger.info('Bun installation script executed successfully.');

    // Update PATH for the current process
    updatePathForBun();

    // Verify installation
    // Sleep briefly to allow the installation to complete
    await new Promise((resolve) => setTimeout(resolve, INSTALLATION_VERIFICATION_DELAY_MS));

    // Check if Bun is now available
    if (await isBunInstalled()) {
      logger.success('Bun has been successfully installed!');
      return true;
    } else {
      logger.error('Bun installation completed but the command is not available in PATH.');
      logger.error('Please restart your terminal or source your shell profile.');
      return false;
    }
  } catch (error) {
    logger.error(
      `Failed to auto-install Bun: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Determines if auto-installation should be attempted
 */
export function shouldAutoInstall(): boolean {
  // Check environment variable
  const autoInstallEnv = process.env.ELIZA_AUTO_INSTALL_BUN;
  if (autoInstallEnv === 'false' || autoInstallEnv === '0') {
    return false;
  }

  // Check if running in CI/CD environment
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) {
    return false;
  }

  // Check if running in a container
  if (process.env.CONTAINER || process.env.DOCKER_CONTAINER) {
    return false;
  }

  return true;
}
