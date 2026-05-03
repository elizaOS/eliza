import { Service, elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { spawn } from "node:child_process";
import { z } from "zod";
import { validateTailscaleConfig } from "../environment";
import type { ITunnelService, TunnelStatus } from "../types";

const CLOUD_BASE_FALLBACK = "https://www.elizacloud.ai/api/v1";

const authKeyResponseSchema = z.object({
  authKey: z.string(),
  tailnet: z.string(),
  magicDnsName: z.string(),
});

type AuthKeyResponse = z.infer<typeof authKeyResponseSchema>;

export interface CloudTailscaleServiceOptions {
  /** Override fetch impl for tests. */
  fetch?: typeof fetch;
  /** Override CLI runner for tests. */
  cliRunner?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function defaultCliRunner(cmd: string, args: string[]): Promise<SpawnResult> {
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

export class CloudTailscaleService extends Service implements ITunnelService {
  static override serviceType = "tunnel";
  readonly capabilityDescription =
    "Provides Tailscale tunnel functionality via Eliza Cloud — auth keys are minted server-side and the local CLI joins the tailnet.";

  private readonly fetchImpl: typeof fetch;
  private readonly cliRunner: (
    cmd: string,
    args: string[],
  ) => Promise<SpawnResult>;

  private tunnelUrl: string | null = null;
  private tunnelPort: number | null = null;
  private startedAt: Date | null = null;
  private isShuttingDown = false;
  private joinedTailnet = false;

  constructor(
    runtime?: IAgentRuntime,
    options: CloudTailscaleServiceOptions = {},
  ) {
    super(runtime);
    this.fetchImpl = options.fetch ?? fetch;
    this.cliRunner = options.cliRunner ?? defaultCliRunner;
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudTailscaleService(runtime);
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    elizaLogger.info("[CloudTailscaleService] started");
  }

  async stop(): Promise<void> {
    await this.stopTunnel();
  }

  async startTunnel(port?: number): Promise<string | void> {
    if (this.isActive()) {
      elizaLogger.warn("[CloudTailscaleService] tunnel already running");
      return this.tunnelUrl ?? undefined;
    }

    if (port === undefined || port === null) {
      elizaLogger.warn(
        "[CloudTailscaleService] startTunnel called without a port — service active but no tunnel started",
      );
      return;
    }

    if (port < 1 || port > 65535) {
      throw new Error("Invalid port number");
    }

    const config = await validateTailscaleConfig(this.runtime);
    const { baseUrl, apiKey } = this.resolveCloudCredentials();

    const response = await this.fetchImpl(
      `${baseUrl}/apis/tunnels/tailscale/auth-key`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          tags: config.TAILSCALE_TAGS,
          expirySeconds: config.TAILSCALE_AUTH_KEY_EXPIRY_SECONDS,
        }),
      },
    );

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(
        `Cloud Tailscale auth-key mint failed (${response.status} ${response.statusText}): ${text}`,
      );
    }

    const rawJson: unknown = await response.json();
    const parsed = authKeyResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new Error(
        `Cloud Tailscale response malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    await this.joinTailnet(parsed.data);
    await this.runServe(port, config.TAILSCALE_FUNNEL);

    this.tunnelUrl = `https://${parsed.data.magicDnsName}`;
    this.tunnelPort = port;
    this.startedAt = new Date();
    this.joinedTailnet = true;
    elizaLogger.info(
      `[CloudTailscaleService] tunnel started: ${this.tunnelUrl}`,
    );
    return this.tunnelUrl;
  }

  async stopTunnel(): Promise<void> {
    if (!this.isActive() && !this.joinedTailnet) {
      elizaLogger.warn("[CloudTailscaleService] no active tunnel to stop");
      return;
    }
    this.isShuttingDown = true;
    elizaLogger.info("[CloudTailscaleService] stopping tunnel");

    if (this.tunnelPort !== null) {
      await this.cliRunner("tailscale", ["serve", "reset"]);
      await this.cliRunner("tailscale", ["funnel", "reset"]);
    }

    if (this.joinedTailnet) {
      await this.cliRunner("tailscale", ["logout"]);
    }

    this.cleanup();
    this.isShuttingDown = false;
    elizaLogger.info("[CloudTailscaleService] tunnel stopped");
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

  private async joinTailnet(payload: AuthKeyResponse): Promise<void> {
    const result = await this.cliRunner("tailscale", [
      "up",
      `--auth-key=${payload.authKey}`,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `tailscale up failed (code ${result.code}): ${result.stderr.trim()}`,
      );
    }
  }

  private async runServe(port: number, funnel: boolean): Promise<void> {
    const args = funnel
      ? ["funnel", String(port)]
      : ["serve", "--bg", "--https=443", `localhost:${port}`];
    const result = await this.cliRunner("tailscale", args);
    if (result.code !== 0) {
      throw new Error(
        `tailscale ${args[0]} failed (code ${result.code}): ${result.stderr.trim()}`,
      );
    }
  }

  private resolveCloudCredentials(): { baseUrl: string; apiKey: string } {
    const apiKey = readNonEmptyString(
      this.runtime.getSetting("ELIZAOS_CLOUD_API_KEY"),
    );
    if (!apiKey) {
      throw new Error(
        "CloudTailscaleService requires ELIZAOS_CLOUD_API_KEY. Set it or use the local backend.",
      );
    }
    const baseRaw =
      readNonEmptyString(this.runtime.getSetting("ELIZAOS_CLOUD_BASE_URL")) ??
      CLOUD_BASE_FALLBACK;
    return { baseUrl: stripTrailingSlash(baseRaw), apiKey };
  }

  private cleanup(): void {
    this.tunnelUrl = null;
    this.tunnelPort = null;
    this.startedAt = null;
    this.joinedTailnet = false;
  }
}

function readNonEmptyString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function safeReadText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500);
}
