import { elizaLogger, type IAgentRuntime, Service } from '@elizaos/core';
import type { ITunnelService, TunnelStatus } from '@elizaos/plugin-tunnel';

interface TunnelConfig {
  provider: 'ngrok';
  authToken?: string;
  region?: string;
  subdomain?: string;
}

/** Coerce runtime.getSetting() (string | number | boolean | null) to string. */
function settingString(
  value: string | number | boolean | null | undefined
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

import { type ChildProcess, spawn } from 'node:child_process';
import * as http from 'node:http';
import { validateNgrokConfig } from '../environment';

export class NgrokService extends Service implements ITunnelService {
  static serviceType = 'tunnel';
  readonly capabilityDescription =
    'Provides secure tunnel functionality using ngrok for exposing local services to the internet';

  private static readonly MIN_TUNNEL_INTERVAL = 2000; // 2 seconds minimum between tunnel starts

  private ngrokProcess: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private tunnelPort: number | null = null;
  private startedAt: Date | null = null;
  private lastStartTime = 0;
  private tunnelConfig: TunnelConfig;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.tunnelConfig = {
      provider: 'ngrok',
      authToken:
        settingString(runtime?.getSetting('NGROK_AUTH_TOKEN')) ?? process.env.NGROK_AUTH_TOKEN,
    };
  }

  async initialize(): Promise<void> {
    elizaLogger.info('🚇 Initializing Ngrok tunnel service...');
    const isInstalled = await this.checkNgrokInstalled();
    if (!isInstalled) {
      throw new Error(
        'ngrok is not installed. Please install it from https://ngrok.com/download or run: brew install ngrok'
      );
    }

    const authToken =
      this.tunnelConfig.authToken ??
      settingString(this.runtime.getSetting('NGROK_AUTH_TOKEN')) ??
      process.env.NGROK_AUTH_TOKEN;

    if (authToken) {
      await this.setAuthToken(authToken);
      elizaLogger.info('Setting ngrok auth token');
    } else {
      elizaLogger.warn('No ngrok auth token found - running in limited mode');
    }
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new NgrokService(runtime);
    await service.start();
    return service;
  }

  // Base Service lifecycle methods
  async start(): Promise<void> {
    elizaLogger.info('NgrokService started');
  }

  async stop(): Promise<void> {
    await this.stopTunnel();
  }

  // ITunnelService implementation
  async startTunnel(port?: number): Promise<string | undefined> {
    if (this.isActive()) {
      elizaLogger.warn('Ngrok tunnel is already running');
      return this.tunnelUrl || undefined;
    }

    if (!port) {
      elizaLogger.warn(
        'NgrokService.start() called without a port. The service will be active but no tunnel will be started.'
      );
      return;
    }

    // Validate environment
    try {
      await validateNgrokConfig(this.runtime);
    } catch (error: any) {
      throw new Error(`Ngrok environment validation failed: ${error.message}`);
    }

    // Enforce rate limiting
    const now = Date.now();
    if (this.lastStartTime && now - this.lastStartTime < NgrokService.MIN_TUNNEL_INTERVAL) {
      const waitTime = NgrokService.MIN_TUNNEL_INTERVAL - (now - this.lastStartTime);
      elizaLogger.warn(`Rate limiting: waiting ${waitTime}ms before starting tunnel`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    this.lastStartTime = Date.now();

    elizaLogger.info(`🚀 Starting ngrok tunnel on port ${port}...`);

    try {
      const tunnelUrl = await this.attemptStartTunnel(port);
      this.tunnelUrl = tunnelUrl;
      this.tunnelPort = port;
      this.startedAt = new Date();
      elizaLogger.success(`✅ Ngrok tunnel started: ${tunnelUrl}`);
      return tunnelUrl;
    } catch (error: any) {
      elizaLogger.error('Failed to start ngrok tunnel:', error);
      throw error;
    }
  }

  private async attemptStartTunnel(port: number): Promise<string> {
    let attempts = 0;
    const maxAttempts = 3;
    const baseDelay = 2000;

    while (attempts < maxAttempts) {
      try {
        return await this.startTunnelInternal(port);
      } catch (error: any) {
        attempts++;

        if (error.message?.includes('domain might already be in use')) {
          if (attempts < maxAttempts) {
            elizaLogger.warn(
              `Domain conflict detected, retrying in ${baseDelay * attempts}ms (attempt ${attempts}/${maxAttempts})`
            );
            await new Promise((resolve) => setTimeout(resolve, baseDelay * attempts));

            // Try to stop any existing process just in case
            if (this.ngrokProcess) {
              this.ngrokProcess.kill();
              this.ngrokProcess = null;
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            continue;
          }
        }

        throw error;
      }
    }

    throw new Error(`Failed to start tunnel after ${maxAttempts} attempts`);
  }

  private async startTunnelInternal(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['http', port.toString()];
      if (this.tunnelConfig.region) {
        args.push('--region', this.tunnelConfig.region);
      }

      // Check for domain configuration
      const domain =
        settingString(this.runtime.getSetting('NGROK_DOMAIN')) ?? process.env.NGROK_DOMAIN;
      const useRandomSubdomain =
        settingString(this.runtime.getSetting('NGROK_USE_RANDOM_SUBDOMAIN')) === 'true';

      if (domain && !useRandomSubdomain) {
        args.push('--domain', domain);
        elizaLogger.info(`Using ngrok domain: ${domain}`);
      } else if (this.tunnelConfig.subdomain && !useRandomSubdomain) {
        // Only use subdomain if explicitly configured and not in test mode
        // Note: Subdomains require a paid ngrok account
        args.push('--subdomain', this.tunnelConfig.subdomain);
        elizaLogger.info(`Using configured subdomain: ${this.tunnelConfig.subdomain}`);
      }
      // For free accounts or when random subdomain is requested,
      // don't specify any domain/subdomain - let ngrok generate a random URL

      this.ngrokProcess = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let errorOccurred = false;

      this.ngrokProcess.on('error', (error) => {
        errorOccurred = true;
        elizaLogger.error(`Failed to start ngrok: ${error.message}`);
        reject(new Error(`Failed to start ngrok: ${error.message}`));
      });

      this.ngrokProcess.stderr?.on('data', (data) => {
        const message = data.toString();
        elizaLogger.error('Ngrok error:', message);

        if (!errorOccurred) {
          errorOccurred = true;
          // Kill the process to clean up
          if (this.ngrokProcess && !this.ngrokProcess.killed) {
            this.ngrokProcess.kill();
          }

          // Handle specific error cases
          if (message.includes('invalid port')) {
            reject(new Error('Invalid port specified'));
          } else if (message.includes('address already in use')) {
            reject(new Error('Port is already in use'));
          } else if (message.includes('ERR_NGROK_15002') || message.includes('Pay-as-you-go')) {
            // Pay-as-you-go account requires domain
            if (!domain) {
              reject(
                new Error(
                  'Pay-as-you-go ngrok account requires NGROK_DOMAIN to be set. Please set NGROK_DOMAIN=your-domain.ngrok-free.app in your .env file'
                )
              );
            } else {
              reject(
                new Error(
                  'Failed to start tunnel with pay-as-you-go account. Ensure your domain is registered at https://dashboard.ngrok.com/domains'
                )
              );
            }
          } else if (
            message.includes('failed to start tunnel') ||
            message.includes('is already bound to another tunnel') ||
            message.includes('tunnel session failed')
          ) {
            // This might happen if the domain is already in use
            reject(new Error('Failed to start tunnel - domain might already be in use'));
          } else {
            reject(new Error(`Ngrok error: ${message}`));
          }
        }
      });

      // Give ngrok more time to start and handle multiple retry attempts
      let retryCount = 0;
      const maxRetries = 3;
      const retryDelay = 2000;

      const tryFetchUrl = async () => {
        if (errorOccurred) {
          return; // Don't try to fetch URL if we already have an error
        }

        try {
          const url = await this.fetchTunnelUrl();
          if (url) {
            this.tunnelUrl = url;
            this.tunnelPort = port;
            this.startedAt = new Date();
            elizaLogger.success(`✅ Ngrok tunnel started: ${url}`);
            resolve(url);
          } else if (retryCount < maxRetries) {
            retryCount++;
            elizaLogger.warn(
              `Retrying to fetch tunnel URL (attempt ${retryCount}/${maxRetries})...`
            );
            setTimeout(tryFetchUrl, retryDelay);
          } else {
            reject(new Error('Failed to get tunnel URL from ngrok after multiple attempts'));
          }
        } catch (error) {
          if (retryCount < maxRetries && !errorOccurred) {
            retryCount++;
            elizaLogger.warn(
              `Retrying to fetch tunnel URL (attempt ${retryCount}/${maxRetries})...`
            );
            setTimeout(tryFetchUrl, retryDelay);
          } else {
            reject(error);
          }
        }
      };

      setTimeout(tryFetchUrl, 2000);
    });
  }

  async stopTunnel(): Promise<void> {
    if (!this.ngrokProcess) {
      elizaLogger.warn('Ngrok tunnel is not running');
      return;
    }
    elizaLogger.info('🛑 Stopping ngrok tunnel...');
    return new Promise((resolve) => {
      if (this.ngrokProcess) {
        this.ngrokProcess.on('exit', () => {
          this.cleanup();
          elizaLogger.info('✅ Ngrok tunnel stopped');
          resolve();
        });
        this.ngrokProcess.kill();
        setTimeout(() => {
          if (this.ngrokProcess && !this.ngrokProcess.killed) {
            this.ngrokProcess.kill('SIGKILL');
          }
          this.cleanup();
          resolve();
        }, 5000);
      } else {
        resolve();
      }
    });
  }

  getUrl(): string | null {
    return this.tunnelUrl;
  }

  isActive(): boolean {
    return this.ngrokProcess !== null && !this.ngrokProcess.killed && this.tunnelUrl !== null;
  }

  getStatus(): TunnelStatus {
    return {
      active: this.isActive(),
      url: this.tunnelUrl,
      port: this.tunnelPort,
      startedAt: this.startedAt,
      provider: 'ngrok',
    };
  }

  private cleanup(): void {
    this.ngrokProcess = null;
    this.tunnelUrl = null;
    this.tunnelPort = null;
    this.startedAt = null;
  }

  private async checkNgrokInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', ['ngrok']);
      proc.on('exit', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  private async setAuthToken(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ngrok', ['config', 'add-authtoken', token]);
      proc.on('exit', (code) => {
        if (code === 0) {
          elizaLogger.info('✅ Ngrok auth token configured');
          resolve();
        } else {
          reject(new Error('Failed to set ngrok auth token'));
        }
      });
      proc.on('error', reject);
    });
  }

  private async fetchTunnelUrl(): Promise<string | null> {
    return new Promise((resolve) => {
      http
        .get('http://localhost:4040/api/tunnels', (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const tunnels = JSON.parse(data);
              const httpsTunnel = tunnels.tunnels?.find((t: any) => t.proto === 'https');
              if (httpsTunnel?.public_url) {
                resolve(httpsTunnel.public_url);
              } else {
                elizaLogger.warn('No HTTPS tunnel found in ngrok response');
                resolve(null);
              }
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              elizaLogger.error(`Failed to parse ngrok API response: ${msg}`);
              resolve(null);
            }
          });
        })
        .on('error', (error) => {
          elizaLogger.error(`Failed to connect to ngrok API: ${error.message}`);
          resolve(null);
        });
    });
  }
}
