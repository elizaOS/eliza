import { existsSync, rmSync } from 'node:fs';
import colors from 'yoctocolors';

/**
 * Wraps an async operation with cleanup handlers that remove the directory
 * if the user interrupts with ctrl-c during the operation
 */
export async function withCleanupOnInterrupt<T>(
  targetDir: string,
  displayName: string,
  fn: () => Promise<T>
): Promise<T> {
  // Check if directory already exists before we start
  const directoryExistedBefore = existsSync(targetDir);

  const cleanup = () => {
    // Clean up if the directory didn't exist before and exists now
    // This handles cases where fn() created the directory but was interrupted
    if (!directoryExistedBefore && existsSync(targetDir)) {
      console.info(colors.red(`\n\nInterrupted! Cleaning up ${displayName}...`));
      try {
        rmSync(targetDir, { recursive: true, force: true });
        console.info('Cleanup completed.');
      } catch (error) {
        console.error(colors.red('Error during cleanup:'), error);
      }
    }
  };

  // store handler references for proper cleanup
  const sigintHandler = () => {
    process.exit(130);
  };
  const sigtermHandler = () => {
    process.exit(143);
  };

  // register cleanup on process exit (handles all termination cases)
  process.on('exit', cleanup);
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  try {
    const result = await fn();

    // success - remove only our cleanup handlers
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);

    return result;
  } catch (error) {
    // remove only our cleanup handlers
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);

    // cleanup on error - if the directory didn't exist before and exists now
    if (!directoryExistedBefore && existsSync(targetDir)) {
      try {
        console.info(colors.red(`\nCleaning up due to error...`));
        rmSync(targetDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // ignore cleanup errors
      }
    }
    throw error;
  }
} 