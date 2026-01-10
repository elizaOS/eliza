import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger.js';

export class PlaywrightInstaller {
  private logger: Logger;
  private isInstalling = false;
  private installPromise: Promise<void> | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Check if Playwright browsers are installed
   */
  private isPlaywrightInstalled(): boolean {
    try {
      // Check if chromium executable exists
      const playwrightPath =
        process.env.PLAYWRIGHT_BROWSERS_PATH ||
        join(process.env.HOME || '/home/eliza', '.cache', 'ms-playwright');

      // Check for chromium directory
      const chromiumPath = join(playwrightPath, 'chromium-*');
      const hasChromium =
        existsSync(playwrightPath) &&
        require('fs')
          .readdirSync(playwrightPath)
          .some((dir: string) => dir.startsWith('chromium-'));

      return hasChromium;
    } catch (error) {
      return false;
    }
  }

  /**
   * Install Playwright browsers
   */
  private async installPlaywright(): Promise<void> {
    this.logger.info('Installing Playwright browsers...');

    return new Promise((resolve, reject) => {
      const npmPath = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const args = ['exec', 'playwright', 'install', 'chromium'];

      this.logger.info(
        'Installing Playwright browsers (without system deps - should be pre-installed)'
      );

      const installProcess = spawn(npmPath, args, {
        stdio: 'pipe',
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':99',
        },
      });

      let stdout = '';
      let stderr = '';

      installProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        this.logger.debug(`Playwright install: ${data.toString().trim()}`);
      });

      installProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        this.logger.debug(`Playwright install stderr: ${data.toString().trim()}`);
      });

      installProcess.on('close', (code) => {
        if (code === 0) {
          this.logger.info('Playwright browsers installed successfully');
          resolve();
        } else {
          const error = new Error(
            `Playwright installation failed with code ${code}\nstderr: ${stderr}`
          );
          this.logger.error('Playwright installation failed:', error);
          reject(error);
        }
      });

      installProcess.on('error', (error) => {
        this.logger.error('Failed to start Playwright installation:', error);
        reject(error);
      });
    });
  }

  /**
   * Ensure Playwright is installed, installing if necessary
   */
  async ensurePlaywrightInstalled(): Promise<void> {
    if (this.isPlaywrightInstalled()) {
      this.logger.info('Playwright browsers already installed');
      return;
    }

    if (this.isInstalling && this.installPromise) {
      this.logger.info('Playwright installation already in progress, waiting...');
      return this.installPromise;
    }

    this.isInstalling = true;
    this.installPromise = this.installPlaywright().finally(() => {
      this.isInstalling = false;
      this.installPromise = null;
    });

    return this.installPromise;
  }

  /**
   * Check if Playwright is ready (installed or being installed)
   */
  isReady(): boolean {
    return this.isPlaywrightInstalled() || this.isInstalling;
  }
}
