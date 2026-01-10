import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@elizaos/core';
import { platform } from 'os';

export class StagehandProcessManager {
  private process: ChildProcess | null = null;
  private isRunning = false;
  private serverPort: number;
  private binaryPath: string | null = null;

  constructor(serverPort: number = 3456) {
    this.serverPort = serverPort;
    this.binaryPath = this.findBinary();
  }

  private getBinaryName(): { primary: string; fallback: string } {
    const platformName = platform();
    const arch = process.arch;
    const ext = platformName === 'win32' ? '.exe' : '';

    // Try architecture-specific binary first, then fall back to platform-only
    return {
      primary: `stagehand-server-${platformName}-${arch}${ext}`,
      fallback: `stagehand-server-${platformName}${ext}`,
    };
  }

  private findBinary(): string | null {
    // Get the directory where this module is located
    const moduleDir = dirname(fileURLToPath(import.meta.url));

    // Check if we're in a Docker container
    const isDocker = process.env.DOCKER_CONTAINER === 'true' || existsSync('/.dockerenv');

    const binaryNames = this.getBinaryName();

    // Possible locations for the binary
    const possiblePaths = [
      // Docker/container paths first
      ...(isDocker
        ? [
            '/usr/local/bin/stagehand-server',
            '/usr/local/bin/stagehand-server-linux',
            '/app/stagehand-server',
            `/app/binaries/${binaryNames.primary}`,
            `/app/binaries/${binaryNames.fallback}`,
          ]
        : []),

      // For local dev, prioritize JS version to avoid signing issues on macOS
      ...(!isDocker ? [join(moduleDir, '../stagehand-server/dist/index.js')] : []),

      // When running from plugin directory - arch-specific first
      join(moduleDir, '../stagehand-server/binaries', binaryNames.primary),
      join(moduleDir, '../stagehand-server/binaries', binaryNames.fallback),
      // When packaged with agentserver
      join(moduleDir, '../../../stagehand-server', binaryNames.primary),
      join(moduleDir, '../../../stagehand-server', binaryNames.fallback),
      // When in node_modules
      join(moduleDir, '../../.bin', 'stagehand-server'),
      // Development fallback - run via node
      join(moduleDir, '../stagehand-server/dist/index.js'),
      // Docker fallback - if binary not found, try JS file
      ...(isDocker
        ? [
            '/app/packages/plugin-stagehand/stagehand-server/dist/index.js',
            '/app/stagehand-server/dist/index.js',
          ]
        : []),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        logger.info(`Found Stagehand server at: ${path}`);
        return path;
      }
    }

    // If no binary found, check if we can run from source
    const srcPath = join(moduleDir, '../stagehand-server/src/index.ts');
    if (existsSync(srcPath)) {
      logger.warn('No compiled binary found, will try to run from source with tsx');
      return srcPath;
    }

    logger.error('Could not find Stagehand server binary or source files');
    logger.error('Searched paths:', possiblePaths);
    return null;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Stagehand server is already running');
      return;
    }

    if (!this.binaryPath) {
      throw new Error(
        'Stagehand server binary not found - please ensure stagehand-server is built'
      );
    }

    const binaryPath = this.binaryPath; // Store in local variable for TypeScript

    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        STAGEHAND_SERVER_PORT: this.serverPort.toString(),
        NODE_ENV: process.env.NODE_ENV || 'production',
        // Pass through relevant environment variables
        BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY,
        BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        BROWSER_HEADLESS: process.env.BROWSER_HEADLESS,
        CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY,
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://ollama:11434',
        OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2-vision',
        // Pass through display for headful mode in container
        DISPLAY: process.env.DISPLAY || ':99',
      };

      // Determine if we're running a binary, JS file, or TS file
      const isBinary = !binaryPath.endsWith('.js') && !binaryPath.endsWith('.ts');
      const isTypeScript = binaryPath.endsWith('.ts');

      if (isBinary) {
        // Run the binary directly
        this.process = spawn(binaryPath, [], { env });
      } else if (isTypeScript) {
        // Run TypeScript via tsx (development mode)
        const tsxPath = require.resolve('tsx/cli', { paths: [process.cwd()] });
        this.process = spawn('node', [tsxPath, binaryPath], { env });
      } else {
        // Run via node (JS file)
        this.process = spawn('node', [binaryPath], { env });
      }

      this.process.stdout?.on('data', (data) => {
        const message = data.toString().trim();
        logger.debug(`[StagehandServer] ${message}`);

        // Check if server is ready
        if (message.includes('listening on port')) {
          this.isRunning = true;
          resolve();
        }
      });

      this.process.stderr?.on('data', (data) => {
        logger.error(`[StagehandServer Error] ${data.toString()}`);
      });

      this.process.on('error', (error) => {
        logger.error('Failed to start Stagehand server:', error);
        this.isRunning = false;
        reject(error);
      });

      this.process.on('exit', (code) => {
        logger.info(`Stagehand server exited with code ${code}`);
        this.isRunning = false;
      });

      // Wait for server to be ready
      this.waitForServer()
        .then(() => resolve())
        .catch((error) => {
          this.isRunning = false;
          if (this.process) {
            this.process.kill('SIGTERM');
          }
          reject(error);
        });
    });
  }

  async waitForServer(): Promise<void> {
    const maxAttempts = 30;
    const delay = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        // Try to establish WebSocket connection for health check
        const ws = require('ws');
        const wsConnection = new ws(`ws://localhost:${this.serverPort}`);

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            wsConnection.close();
            reject(new Error('Connection timeout'));
          }, 5000);

          wsConnection.on('open', () => {
            clearTimeout(timeout);
            wsConnection.close();
            resolve();
          });

          wsConnection.on('error', (error: any) => {
            clearTimeout(timeout);
            reject(error);
          });
        });

        logger.info('Stagehand server is ready');
        return;
      } catch (error) {
        // Server not ready yet, continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new Error('Stagehand server failed to start');
  }

  async stop(): Promise<void> {
    if (!this.process || !this.isRunning) {
      return;
    }

    return new Promise((resolve) => {
      this.process!.on('exit', () => {
        this.isRunning = false;
        resolve();
      });

      // Try graceful shutdown first
      this.process!.kill('SIGTERM');

      // Force kill after timeout
      setTimeout(() => {
        if (this.isRunning && this.process) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  getServerUrl(): string {
    return `ws://localhost:${this.serverPort}`;
  }
}
