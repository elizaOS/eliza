import {
  isGlobalInstallation,
  isRunningViaBunx,
  isRunningViaNpx,
  getPackageManager,
} from '@/src/utils';
import { isCliInstalledViaNpm } from '@/src/utils/cli-bun-migration';
import { CliEnvironment } from '../types';

/**
 * Get CLI environment information
 */
export async function getCliEnvironment(): Promise<CliEnvironment> {
  const [isGlobal, isNpx, isBunx, isNpmInstalled, packageManager] = await Promise.all([
    isGlobalInstallation(),
    isRunningViaNpx(),
    isRunningViaBunx(),
    isCliInstalledViaNpm(),
    getPackageManager(),
  ]);

  return {
    isGlobal,
    isNpx,
    isBunx,
    isNpmInstalled,
    packageManager,
  };
}
