import { spawn } from "node:child_process";
import { elizaLogger, type IAgentRuntime, Service } from "@elizaos/core";
import { z } from "zod";
import { validateTailscaleConfig } from "../environment";
import type { ITunnelService, TunnelStatus } from "../types";

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
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

function checkTailscaleInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("which", ["tailscale"]);
    proc.on("exit", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
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

export class LocalTailscaleService extends Service implements ITunnelService {
  static override serviceType = "tunnel";
  readonly capabilityDescription =
    "Provides secure tunnel functionality via the locally-installed `tailscale` CLI (serve / funnel).";

  private tunnelUrl: string | null = null;
  private tunnelPort: number | null = null;
  private startedAt: Date | null = null;
  private isShuttingDown = false;
  private useFunnel = false;

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new LocalTailscaleService(runtime);
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    elizaLogger.info("[LocalTailscaleService] starting");
    const installed = await checkTailscaleInstalled();
    if (!installed) {
      throw new Error(
        "tailscale is not installed. Install from https://tailscale.com/download or run: brew install tailscale",
      );
    }
  }

  async stop(): Promise<void> {
    await this.stopTunnel();
  }

  async startTunnel(
    port?: number,
    options: { accountId?: string } = {},
  ): Promise<string | undefined> {
    if (this.isActive()) {
      elizaLogger.warn("[LocalTailscaleService] tunnel already running");
      return this.tunnelUrl ?? undefined;
    }

    if (port === undefined || port === null) {
      elizaLogger.warn(
        "[LocalTailscaleService] startTunnel called without a port — service active but no tunnel started",
      );
      return;
    }

    if (port < 1 || port > 65535) {
      throw new Error("Invalid port number");
    }

    const config = await validateTailscaleConfig(
      this.runtime,
      options.accountId,
    );
    this.useFunnel = config.TAILSCALE_FUNNEL;

    elizaLogger.info(
      `[LocalTailscaleService] starting tunnel on port ${port} (funnel=${this.useFunnel})`,
    );

    if (this.useFunnel) {
      const result = await runCommand("tailscale", ["funnel", String(port)]);
      if (result.code !== 0) {
        throw new Error(
          `tailscale funnel exited with code ${result.code}: ${result.stderr.trim()}`,
        );
      }
    } else {
      const result = await runCommand("tailscale", [
        "serve",
        "--bg",
        "--https=443",
        `localhost:${port}`,
      ]);
      if (result.code !== 0) {
        throw new Error(
          `tailscale serve exited with code ${result.code}: ${result.stderr.trim()}`,
        );
      }
    }

    const dnsName = await this.fetchSelfDnsName();
    if (!dnsName) {
      throw new Error(
        "tailscale serve started but no DNSName resolved from `tailscale status --json`",
      );
    }
    this.tunnelUrl = this.useFunnel
      ? `https://${dnsName}`
      : `https://${dnsName}`;
    this.tunnelPort = port;
    this.startedAt = new Date();
    elizaLogger.info(
      `[LocalTailscaleService] tunnel started: ${this.tunnelUrl}`,
    );
    return this.tunnelUrl;
  }

  async stopTunnel(_options: { accountId?: string } = {}): Promise<void> {
    if (!this.isActive()) {
      elizaLogger.warn("[LocalTailscaleService] no active tunnel to stop");
      return;
    }
    this.isShuttingDown = true;
    elizaLogger.info("[LocalTailscaleService] stopping tunnel");

    if (this.useFunnel) {
      await runCommand("tailscale", ["funnel", "reset"]);
    } else {
      await runCommand("tailscale", ["serve", "reset"]);
    }

    this.cleanup();
    this.isShuttingDown = false;
    elizaLogger.info("[LocalTailscaleService] tunnel stopped");
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
      provider: "tailscale",
    };
  }

  private async fetchSelfDnsName(): Promise<string | null> {
    const result = await runCommand("tailscale", ["status", "--json"]);
    if (result.code !== 0) {
      elizaLogger.error(
        `[LocalTailscaleService] tailscale status failed: ${result.stderr.trim()}`,
      );
      return null;
    }
    const status = parseTailscaleStatus(result.stdout);
    if (!status) {
      elizaLogger.error(
        "[LocalTailscaleService] tailscale status returned malformed JSON",
      );
      return null;
    }
    const raw = status.Self?.DNSName;
    if (!raw) return null;
    return raw.replace(/\.$/, "");
  }

  private cleanup(): void {
    this.tunnelUrl = null;
    this.tunnelPort = null;
    this.startedAt = null;
    this.useFunnel = false;
  }
}
