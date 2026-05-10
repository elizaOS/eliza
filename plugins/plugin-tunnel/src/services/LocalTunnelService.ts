import { spawn } from 'node:child_process';
import { elizaLogger, type IAgentRuntime, Service } from '@elizaos/core';
import { z } from 'zod';
import { validateTunnelConfig } from '../environment';
import type { ITunnelService, TunnelStatus } from '../types';

const tailscaleStatusPeerSchema = z.object({
  DNSName: z.string().optional(),
  Online: z.boolean().optional(),
});

const tailscaleStatusSchema = z.object({
  Self: z
    .object({
      DNSName: z.string().optional(),
    })
    .optional(),
  MagicDNSSuffix: z.string().optional(),
  Peer: z.record(z.string(), tailscaleStatusPeerSchema).optional(),
});

type TailscaleStatus = z.infer<typeof tailscaleStatusSchema>;

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    );
  });
}

export function checkTailscaleInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['tailscale']);
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function parseTailscaleStatus(stdout: string): TailscaleStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const result = tailscaleStatusSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Tunnel service backed by the locally-installed `tailscale` CLI.
 *
 * The user is responsible for `tailscale up` (i.e. authenticating with
 * Tailscale's coordination server, OR with a self-hosted headscale via
 * `--login-server`). This service just calls `tailscale serve` / `tailscale
 * funnel` to expose a port and reads `tailscale status --json` to learn the
 * tailnet DNS name.
 *
 * Coexists with `@elizaos/plugin-elizacloud`'s cloud tunnel and
 * `@elizaos/plugin-ngrok` — only the first one to register `serviceType="tunnel"`
 * wins. This service registers itself only if the `tailscale` binary is on
 * `PATH`, gating out machines that have no Tailscale install.
 */
export class LocalTunnelService extends Service implements ITunnelService {
  static override serviceType = 'tunnel';
  readonly capabilityDescription =
    'Tunnel via the locally-installed `tailscale` CLI (serve / funnel). User authenticates separately with `tailscale up`.';

  private tunnelUrl: string | null = null;
  private tunnelPort: number | null = null;
  private startedAt: Date | null = null;
  private isShuttingDown = false;
  private useFunnel = false;

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new LocalTunnelService(runtime);
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    elizaLogger.info('[LocalTunnelService] starting');
    const installed = await checkTailscaleInstalled();
    if (!installed) {
      throw new Error(
        'tailscale is not installed. Install from https://tailscale.com/download or run: brew install tailscale'
      );
    }
  }

  async stop(): Promise<void> {
    await this.stopTunnel();
  }

  async startTunnel(port?: number): Promise<string | undefined> {
    if (this.isActive()) {
      elizaLogger.warn('[LocalTunnelService] tunnel already running');
      return this.tunnelUrl ?? undefined;
    }

    if (port === undefined || port === null) {
      elizaLogger.warn(
        '[LocalTunnelService] startTunnel called without a port — service active but no tunnel started'
      );
      return;
    }

    if (port < 1 || port > 65535) {
      throw new Error('Invalid port number');
    }

    const config = await validateTunnelConfig(this.runtime);
    this.useFunnel = config.TUNNEL_FUNNEL;

    elizaLogger.info(
      `[LocalTunnelService] starting tunnel on port ${port} (funnel=${this.useFunnel})`
    );

    if (this.useFunnel) {
      const result = await runCommand('tailscale', ['funnel', String(port)]);
      if (result.code !== 0) {
        throw new Error(
          `tailscale funnel exited with code ${result.code}: ${result.stderr.trim()}`
        );
      }
    } else {
      const result = await runCommand('tailscale', [
        'serve',
        '--bg',
        '--https=443',
        `localhost:${port}`,
      ]);
      if (result.code !== 0) {
        throw new Error(`tailscale serve exited with code ${result.code}: ${result.stderr.trim()}`);
      }
    }

    const dnsName = await this.fetchSelfDnsName();
    if (!dnsName) {
      throw new Error(
        'tailscale serve started but no DNSName resolved from `tailscale status --json`'
      );
    }
    this.tunnelUrl = `https://${dnsName}`;
    this.tunnelPort = port;
    this.startedAt = new Date();
    elizaLogger.info(`[LocalTunnelService] tunnel started: ${this.tunnelUrl}`);
    return this.tunnelUrl;
  }

  async stopTunnel(): Promise<void> {
    if (!this.isActive()) {
      elizaLogger.warn('[LocalTunnelService] no active tunnel to stop');
      return;
    }
    this.isShuttingDown = true;
    elizaLogger.info('[LocalTunnelService] stopping tunnel');

    if (this.useFunnel) {
      await runCommand('tailscale', ['funnel', 'reset']);
    } else {
      await runCommand('tailscale', ['serve', 'reset']);
    }

    this.cleanup();
    this.isShuttingDown = false;
    elizaLogger.info('[LocalTunnelService] tunnel stopped');
  }

  getUrl(): string | null {
    return this.tunnelUrl;
  }

  isActive(): boolean {
    return this.tunnelUrl !== null && !this.isShuttingDown;
  }

  getStatus(): TunnelStatus {
    return {
      active: this.isActive(),
      url: this.tunnelUrl,
      port: this.tunnelPort,
      startedAt: this.startedAt,
      provider: 'tailscale',
      backend: 'local-cli',
    };
  }

  private async fetchSelfDnsName(): Promise<string | null> {
    const result = await runCommand('tailscale', ['status', '--json']);
    if (result.code !== 0) {
      elizaLogger.error(`[LocalTunnelService] tailscale status failed: ${result.stderr.trim()}`);
      return null;
    }
    const status = parseTailscaleStatus(result.stdout);
    if (!status) {
      elizaLogger.error('[LocalTunnelService] tailscale status returned malformed JSON');
      return null;
    }
    const raw = status.Self?.DNSName;
    if (!raw) return null;
    return raw.replace(/\.$/, '');
  }

  private cleanup(): void {
    this.tunnelUrl = null;
    this.tunnelPort = null;
    this.startedAt = null;
    this.useFunnel = false;
  }
}
