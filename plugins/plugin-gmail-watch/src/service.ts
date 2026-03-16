/**
 * @module service
 * @description GmailWatchService – manages the gog gmail watch serve child process.
 *
 * On start:
 *   1. Reads hooks.gmail config from character settings
 *   2. Spawns `gog gmail watch serve` as a child process
 *   3. Sets up auto-renew timer (default every 6 hours)
 *   4. The child process receives Pub/Sub pushes and forwards them
 *      to the webhooks plugin's /hooks/gmail endpoint
 *
 * On stop:
 *   1. Kills the child process
 *   2. Clears the auto-renew timer
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { spawn, type ChildProcess } from 'node:child_process';
import { which } from './utils.js';

const GMAIL_WATCH_SERVICE_TYPE = 'GMAIL_WATCH';
const DEFAULT_BIND = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_PATH = '/gmail-pubsub';
const DEFAULT_RENEW_MINUTES = 360; // 6 hours
const DEFAULT_MAX_BYTES = 20000;

export interface GmailWatchConfig {
  account: string;
  label: string;
  topic: string;
  subscription?: string;
  pushToken: string;
  hookUrl: string;
  hookToken: string;
  includeBody: boolean;
  maxBytes: number;
  renewEveryMinutes: number;
  serve: {
    bind: string;
    port: number;
    path: string;
  };
}

function resolveGmailConfig(runtime: IAgentRuntime): GmailWatchConfig | null {
  const settings = (runtime.character?.settings ?? {}) as Record<string, unknown>;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const gmail = (hooks.gmail ?? {}) as Record<string, unknown>;

  const account = typeof gmail.account === 'string' ? gmail.account.trim() : '';
  if (!account) {
    return null;
  }

  const hooksToken = typeof hooks.token === 'string' ? hooks.token.trim() : '';

  const serve = (gmail.serve ?? {}) as Record<string, unknown>;

  return {
    account,
    label: typeof gmail.label === 'string' ? gmail.label : 'INBOX',
    topic: typeof gmail.topic === 'string' ? gmail.topic : '',
    subscription: typeof gmail.subscription === 'string' ? gmail.subscription : undefined,
    pushToken: typeof gmail.pushToken === 'string' ? gmail.pushToken : '',
    hookUrl: typeof gmail.hookUrl === 'string' ? gmail.hookUrl : `http://127.0.0.1:18789/hooks/gmail`,
    hookToken: hooksToken,
    includeBody: gmail.includeBody !== false,
    maxBytes: typeof gmail.maxBytes === 'number' ? gmail.maxBytes : DEFAULT_MAX_BYTES,
    renewEveryMinutes:
      typeof gmail.renewEveryMinutes === 'number' ? gmail.renewEveryMinutes : DEFAULT_RENEW_MINUTES,
    serve: {
      bind: typeof serve.bind === 'string' ? serve.bind : DEFAULT_BIND,
      port: typeof serve.port === 'number' ? serve.port : DEFAULT_PORT,
      path: typeof serve.path === 'string' ? serve.path : DEFAULT_PATH,
    },
  };
}

export class GmailWatchService extends Service {
  static serviceType = GMAIL_WATCH_SERVICE_TYPE;
  capabilityDescription = 'Manages Gmail Pub/Sub watch and push forwarding via gog CLI';

  private childProcess: ChildProcess | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private gmailConfig: GmailWatchConfig | null = null;
  private restartAttempts = 0;
  private static readonly MAX_RESTART_ATTEMPTS = 10;
  private static readonly INITIAL_RESTART_DELAY_MS = 10_000;
  private static readonly MAX_RESTART_DELAY_MS = 300_000; // 5 minutes

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new GmailWatchService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    this.gmailConfig = resolveGmailConfig(this.runtime);
    if (!this.gmailConfig) {
      logger.info('[GmailWatch] No hooks.gmail.account configured, skipping');
      return;
    }

    // Check if gog binary exists
    const gogPath = await which('gog');
    if (!gogPath) {
      logger.warn('[GmailWatch] gog binary not found in PATH. Install gogcli: https://gogcli.sh/');
      return;
    }

    await this.spawnWatcher();
    this.startRenewTimer();

    logger.info(
      `[GmailWatch] Started for ${this.gmailConfig.account} (renew every ${this.gmailConfig.renewEveryMinutes}m)`
    );
  }

  async stop(): Promise<void> {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.childProcess) {
      this.childProcess.kill('SIGTERM');
      this.childProcess = null;
    }
    logger.info('[GmailWatch] Stopped');
  }

  private async spawnWatcher(): Promise<void> {
    if (!this.gmailConfig) {
      return;
    }

    const args = [
      'gmail', 'watch', 'serve',
      '--account', this.gmailConfig.account,
      '--bind', this.gmailConfig.serve.bind,
      '--port', String(this.gmailConfig.serve.port),
      '--path', this.gmailConfig.serve.path,
      '--hook-url', this.gmailConfig.hookUrl,
    ];

    if (this.gmailConfig.hookToken) {
      args.push('--hook-token', this.gmailConfig.hookToken);
    }
    if (this.gmailConfig.pushToken) {
      args.push('--token', this.gmailConfig.pushToken);
    }
    if (this.gmailConfig.includeBody) {
      args.push('--include-body');
    }
    if (this.gmailConfig.maxBytes) {
      args.push('--max-bytes', String(this.gmailConfig.maxBytes));
    }

    logger.debug(`[GmailWatch] Spawning: gog ${args.join(' ')}`);

    this.childProcess = spawn('gog', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Reset restart counter on successful launch
    this.restartAttempts = 0;

    this.childProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logger.debug(`[GmailWatch:stdout] ${line}`);
      }
    });

    this.childProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logger.warn(`[GmailWatch:stderr] ${line}`);
      }
    });

    this.childProcess.on('exit', (code, signal) => {
      logger.warn(`[GmailWatch] Child process exited (code=${code}, signal=${signal})`);
      this.childProcess = null;

      // Auto-restart with exponential backoff if the service is still active
      if (this.renewTimer && this.gmailConfig) {
        this.restartAttempts++;

        if (this.restartAttempts > GmailWatchService.MAX_RESTART_ATTEMPTS) {
          logger.error(
            `[GmailWatch] Max restart attempts (${GmailWatchService.MAX_RESTART_ATTEMPTS}) reached. ` +
            `Giving up. Check gog configuration and restart the service manually.`
          );
          return;
        }

        const delayMs = Math.min(
          GmailWatchService.INITIAL_RESTART_DELAY_MS * Math.pow(2, this.restartAttempts - 1),
          GmailWatchService.MAX_RESTART_DELAY_MS,
        );
        logger.info(
          `[GmailWatch] Auto-restarting in ${Math.round(delayMs / 1000)}s ` +
          `(attempt ${this.restartAttempts}/${GmailWatchService.MAX_RESTART_ATTEMPTS})`
        );

        setTimeout(() => {
          if (this.gmailConfig && this.renewTimer) {
            this.spawnWatcher();
          }
        }, delayMs);
      }
    });
  }

  private startRenewTimer(): void {
    if (!this.gmailConfig) {
      return;
    }

    const intervalMs = this.gmailConfig.renewEveryMinutes * 60 * 1000;
    this.renewTimer = setInterval(async () => {
      await this.renewWatch();
    }, intervalMs);
  }

  private async renewWatch(): Promise<void> {
    if (!this.gmailConfig) {
      return;
    }

    logger.info(`[GmailWatch] Renewing watch for ${this.gmailConfig.account}`);

    const gogPath = await which('gog');
    if (!gogPath) {
      logger.warn('[GmailWatch] gog binary not found, cannot renew');
      return;
    }

    const args = [
      'gmail', 'watch', 'start',
      '--account', this.gmailConfig.account,
      '--label', this.gmailConfig.label,
    ];
    if (this.gmailConfig.topic) {
      args.push('--topic', this.gmailConfig.topic);
    }

    const renewProcess = spawn('gog', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    renewProcess.stdout?.on('data', (data: Buffer) => {
      logger.debug(`[GmailWatch:renew:stdout] ${data.toString().trim()}`);
    });
    renewProcess.stderr?.on('data', (data: Buffer) => {
      logger.warn(`[GmailWatch:renew:stderr] ${data.toString().trim()}`);
    });

    await new Promise<void>((resolve) => {
      renewProcess.on('exit', (code) => {
        if (code === 0) {
          logger.info('[GmailWatch] Watch renewed successfully');
        } else {
          logger.warn(`[GmailWatch] Watch renewal exited with code ${code}`);
        }
        resolve();
      });
    });
  }
}
