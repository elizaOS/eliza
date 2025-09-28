import { logger } from '@elizaos/core';

/**
 * Handles on-demand plugin installation using Bun.
 * Provides environment guards and single-attempt tracking per process.
 */
export class PluginInstaller {
  private attempted = new Set<string>();

  async tryInstall(pluginName: string): Promise<boolean> {
    try {
      if (!this.isAllowed()) {
        logger.debug(
          `Auto-install disabled or not allowed in this environment. Skipping install for ${pluginName}.`
        );
        return false;
      }

      if (this.attempted.has(pluginName)) {
        logger.debug(`Auto-install already attempted for ${pluginName}. Skipping.`);
        return false;
      }
      this.attempted.add(pluginName);

      // Verify Bun availability
      try {
        const check = Bun.spawn(['bun', '--version'], { stdout: 'pipe', stderr: 'pipe' });
        const code = await check.exited;
        if (code !== 0) {
          logger.warn(
            `Bun not available on PATH. Cannot auto-install ${pluginName}. Please run: bun add ${pluginName}`
          );
          return false;
        }
      } catch {
        logger.warn(
          `Bun not available on PATH. Cannot auto-install ${pluginName}. Please run: bun add ${pluginName}`
        );
        return false;
      }

      logger.info(`Attempting to auto-install missing plugin: ${pluginName}`);
      const install = Bun.spawn(['bun', 'add', pluginName], {
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        stdout: 'inherit',
        stderr: 'inherit',
      });
      const exit = await install.exited;

      if (exit === 0) {
        logger.info(`Successfully installed ${pluginName}. Retrying import...`);
        return true;
      }

      logger.error(`bun add ${pluginName} failed with exit code ${exit}. Please install manually.`);
      return false;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`Unexpected error during auto-install of ${pluginName}: ${message}`);
      return false;
    }
  }

  private isAllowed(): boolean {
    if (process.env.ELIZA_NO_AUTO_INSTALL === 'true') return false;
    if (process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL === 'true') return false;
    if (process.env.CI === 'true') return false;
    if (process.env.ELIZA_TEST_MODE === 'true') return false;
    if (process.env.NODE_ENV === 'test') return false;
    return true;
  }
}

export const pluginInstaller = new PluginInstaller();
