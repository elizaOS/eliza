import { spawn } from "node:child_process";
import { elizaLogger, type IAgentRuntime, Service } from "@elizaos/core";
import { z } from "zod";
import { readTailscaleAccounts, resolveTailscaleAccount } from "../accounts";
import { validateTailscaleConfig } from "../environment";
import type { ITunnelService, TunnelStatus } from "../types";

const CLOUD_BASE_FALLBACK = "https://api.elizacloud.ai/api/v1";

const authKeyResponseSchema = z.object({
  authKey: z.string(),
  tailnet: z.string(),
  loginServer: z.string().optional(),
  hostname: z.string().optional(),
  magicDnsName: z.string(),
  billing: z
    .object({
      model: z.literal("on_demand"),
      unit: z.string(),
      charged: z.boolean(),
      amountUsd: z.number().nonnegative(),
      subscription: z.boolean(),
    })
    .optional(),
});

type AuthKeyResponse = z.infer<typeof authKeyResponseSchema>;
export type CloudTunnelProvisionBilling = NonNullable<AuthKeyResponse["billing"]>;

interface CloudFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

interface CloudFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type CloudFetch = (
  url: string,
  init: CloudFetchInit,
) => Promise<CloudFetchResponse>;

interface CloudTailscaleServiceOptions {
  /** Override fetch impl for tests. */
  fetch?: CloudFetch;
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

async function defaultFetch(
  url: string,
  init: CloudFetchInit,
): Promise<CloudFetchResponse> {
  return normalizeFetchResponse(await fetch(url, init));
}

export class CloudTailscaleService extends Service implements ITunnelService {
  static override serviceType = "tunnel";
  readonly capabilityDescription =
    "Provides Tailscale tunnel functionality via Eliza Cloud — auth keys are minted server-side and the local CLI joins the tailnet.";

  private readonly fetchImpl: CloudFetch;
  private readonly cliRunner: (
    cmd: string,
    args: string[],
  ) => Promise<SpawnResult>;

  private tunnelUrl: string | null = null;
  private tunnelPort: number | null = null;
  private startedAt: Date | null = null;
  private lastProvisioningBilling: CloudTunnelProvisionBilling | null = null;
  private isShuttingDown = false;
  private joinedTailnet = false;

  constructor(
    runtime?: IAgentRuntime,
    options: CloudTailscaleServiceOptions = {},
  ) {
    super(runtime);
    this.fetchImpl = options.fetch ?? defaultFetch;
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

  async startTunnel(
    port?: number,
    options: { accountId?: string } = {},
  ): Promise<string | undefined> {
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

    const config = await validateTailscaleConfig(
      this.runtime,
      options.accountId,
    );
    const { baseUrl, apiKey } = this.resolveCloudCredentials(options.accountId);

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
    this.lastProvisioningBilling = parsed.data.billing ?? null;
    this.joinedTailnet = true;
    elizaLogger.info(
      `[CloudTailscaleService] tunnel started: ${this.tunnelUrl}`,
    );
    return this.tunnelUrl;
  }

  async stopTunnel(_options: { accountId?: string } = {}): Promise<void> {
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

  getLastProvisioningBilling(): CloudTunnelProvisionBilling | null {
    return this.lastProvisioningBilling;
  }

  private async joinTailnet(payload: AuthKeyResponse): Promise<void> {
    const args = ["up", `--auth-key=${payload.authKey}`];
    const loginServer =
      payload.loginServer ??
      (payload.tailnet.startsWith("http") ? payload.tailnet : null);
    if (loginServer) {
      args.push(`--login-server=${loginServer}`);
    }
    if (payload.hostname) {
      args.push(`--hostname=${payload.hostname}`);
    }

    const result = await this.cliRunner("tailscale", args);
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

  private resolveCloudCredentials(accountId?: string): {
    baseUrl: string;
    apiKey: string;
  } {
    const account = accountId
      ? resolveTailscaleAccount(readTailscaleAccounts(this.runtime), accountId)
      : null;
    const apiKey =
      readNonEmptyString(account?.cloudApiKey) ??
      readNonEmptyString(this.runtime.getSetting("ELIZAOS_CLOUD_API_KEY"));
    if (!apiKey) {
      throw new Error(
        "CloudTailscaleService requires ELIZAOS_CLOUD_API_KEY. Set it or use the local backend.",
      );
    }
    const baseRaw =
      readNonEmptyString(account?.cloudBaseUrl) ??
      readNonEmptyString(this.runtime.getSetting("ELIZAOS_CLOUD_BASE_URL")) ??
      CLOUD_BASE_FALLBACK;
    return { baseUrl: stripTrailingSlash(baseRaw), apiKey };
  }

  private cleanup(): void {
    this.tunnelUrl = null;
    this.tunnelPort = null;
    this.startedAt = null;
    this.lastProvisioningBilling = null;
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

async function safeReadText(response: CloudFetchResponse): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500);
}

function normalizeFetchResponse(value: unknown): CloudFetchResponse {
  if (!isRecord(value)) {
    throw new Error("Cloud Tailscale fetch returned a non-object response");
  }

  const { ok, status, statusText, json, text } = value;
  if (
    typeof ok !== "boolean" ||
    typeof status !== "number" ||
    typeof statusText !== "string" ||
    typeof json !== "function" ||
    typeof text !== "function"
  ) {
    throw new Error(
      "Cloud Tailscale fetch response is missing required fields",
    );
  }

  return {
    ok,
    status,
    statusText,
    json: async () => json.call(value),
    text: async () => String(await text.call(value)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
