import { logger } from '@elizaos/core';
import { bunExec, bunExecInherit, bunExecSimple } from '@/src/utils/bun-exec';

/**
 * Check if bun is available on the system
 */
export async function isBunAvailable(): Promise<boolean> {
  try {
    await bunExec('bun', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Check if the CLI was installed via npm globally
 * Handles multiple node versions (nvm scenarios)
 */
export async function isCliInstalledViaNpm(): Promise<boolean> {
  try {
    const { stdout } = await bunExecSimple('npm', ['list', '-g', '@elizaos/cli', '--depth=0']);
    return stdout.includes('@elizaos/cli');
  } catch (error) {
    // Also check if the current elizaos command points to npm installation
    try {
      const { stdout: whichOutput } = await bunExecSimple('which', ['elizaos']);
      return whichOutput.includes('node_modules') || whichOutput.includes('.nvm');
    } catch {
      return false;
    }
  }
}

/**
 * Remove the CLI from npm global installation
 */
async function removeNpmInstallation(): Promise<void> {
  logger.info('Removing npm installation of @elizaos/cli...');
  await bunExecInherit('npm', ['uninstall', '-g', '@elizaos/cli']);
}

/**
 * Install the CLI using bun globally
 */
async function installCliWithBun(version: string): Promise<void> {
  logger.info('Installing CLI with bun...');
  await bunExecInherit('bun', ['add', '-g', `@elizaos/cli@${version}`]);
}

/**
 * Verify the CLI installation works and returns expected version
 */
async function verifyCliInstallation(expectedVersion: string): Promise<boolean> {
  try {
    const { stdout } = await bunExecSimple('elizaos', ['-v']);
    const output = stdout.trim();

    // Extract version using regex pattern (handles v1.0.6, 1.0.6, etc.)
    const versionMatch = output.match(/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/);

    if (!versionMatch) {
      return false;
    }

    const actualVersion = versionMatch[1];

    // Flexible comparison - exact match or version contained in expected
    return (
      actualVersion === expectedVersion ||
      expectedVersion.includes(actualVersion) ||
      actualVersion.includes(expectedVersion)
    );
  } catch {
    return false;
  }
}

/**
 * Atomic migration: CLI from npm to bun installation
 * Installs bun version first, only removes npm if successful
 */
export async function migrateCliToBun(targetVersion: string): Promise<void> {
  // Step 1: Check bun availability
  if (!(await isBunAvailable())) {
    throw new Error(
      'Bun is not available. Please install bun first: https://bun.sh/docs/installation'
    );
  }

  logger.info('Starting atomic CLI migration from npm to bun...');

  try {
    // Step 2: Install with bun (without removing npm yet)
    await installCliWithBun(targetVersion);

    // Step 3: Verify bun installation works
    logger.info('Verifying bun installation...');
    if (!(await verifyCliInstallation(targetVersion))) {
      throw new Error('Bun installation verification failed');
    }

    // Step 4: Only now remove npm installation (since bun works)
    logger.info('Bun installation successful, removing npm installation...');
    await removeNpmInstallation();

    logger.info('✅ CLI migration completed successfully! You may need to restart your terminal.');
  } catch (error) {
    logger.error(
      `❌ CLI migration failed: ${error instanceof Error ? error.message : String(error)}`
    );
    logger.error('Your original npm installation is still intact.');

    // Try to clean up failed bun installation
    try {
      logger.info('Cleaning up failed bun installation...');
      await bunExec('bun', ['remove', '-g', '@elizaos/cli'], { stdio: 'ignore' });
    } catch {
      // Ignore cleanup errors
    }

    throw error;
  }
}
