/**
 * Hetzner Cloud API client.
 *
 * Thin wrapper over the Hetzner Cloud REST API
 * (https://docs.hetzner.cloud/) used by the autoscaler to provision and
 * decommission VPS nodes that join the Docker pool. Auctioned/dedicated
 * nodes are out of scope here — those are registered manually because
 * they have separate billing semantics.
 *
 * No SDK dependency: native `fetch` keeps this Worker-safe and avoids a
 * heavy transitive dep tree. The control plane is Node-only because of
 * `ssh2` elsewhere, but this module itself has no Node-only imports.
 */

import { containersEnv } from "../../config/containers-env";
import { logger } from "../../utils/logger";
import type {
  ComputeProvider,
  CreateServerInput,
  CreateVolumeInput,
  ProvisionedServer,
} from "./compute-provider";

// Re-export the canonical input/result types so existing importers of these
// names from `hetzner-cloud-api` keep resolving after the seam extraction.
export type { CreateServerInput, CreateVolumeInput, ProvisionedServer } from "./compute-provider";

const OFFICIAL_HCLOUD_API_BASE = "https://api.hetzner.cloud/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const MAX_LIST_PAGES = 10_000;

export type HetznerCloudErrorCode =
  | "missing_token"
  | "invalid_input"
  | "not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "server_error"
  | "transport_error";

export interface HetznerRetryMetadata {
  retryAfterSeconds?: number;
  resetAtEpochSeconds?: number;
}

export class HetznerCloudError extends Error {
  constructor(
    public readonly code: HetznerCloudErrorCode,
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
    public readonly retry?: HetznerRetryMetadata,
  ) {
    super(message);
    this.name = "HetznerCloudError";
  }
}

export interface HetznerServerType {
  id: number;
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  architecture: "x86" | "arm";
  storage_type: "local" | "network";
}

export interface HetznerLocation {
  id: number;
  name: string;
  city: string;
  country: string;
}

export interface HetznerImage {
  id: number;
  name: string | null;
  description: string;
  type: string;
  os_flavor: string;
  os_version: string | null;
}

export interface HetznerServer {
  id: number;
  name: string;
  status:
    | "initializing"
    | "starting"
    | "running"
    | "stopping"
    | "off"
    | "deleting"
    | "rebuilding"
    | "migrating"
    | "unknown";
  created: string;
  public_net: {
    ipv4: { ip: string; blocked: boolean } | null;
    ipv6: { ip: string; blocked: boolean } | null;
    firewalls?: Array<{ id: number; status: string }>;
  };
  /** Canonical public address mapped from `public_net` (satisfies the seam). */
  publicIpv4?: string | null;
  /** Canonical firewall attachment state mapped from `public_net`. */
  firewallAttachments?: Array<{ id: number; status: string }>;
  server_type: { id: number; name: string };
  datacenter: { id: number; name: string; location: HetznerLocation };
  labels: Record<string, string>;
}

export interface HetznerAction {
  id: number;
  command: string;
  status: "running" | "success" | "error";
  progress: number;
  error: { code: string; message: string } | null;
}

export interface HetznerVolume {
  id: number;
  name: string;
  size: number;
  /** Linux device path (`/dev/disk/by-id/scsi-...`) once attached. */
  linux_device: string | null;
  /** Server id this volume is currently attached to (null = unattached). */
  server: number | null;
  location: HetznerLocation;
  format: string | null;
  status: "creating" | "available";
  labels: Record<string, string>;
  created: string;
}

// `CreateServerInput`, `CreateVolumeInput`, and `ProvisionedServer` now live
// canonically in `./compute-provider` and are re-exported above.

// ---------------------------------------------------------------------------
// HetznerCloudClient
// ---------------------------------------------------------------------------

export class HetznerCloudClient implements ComputeProvider {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly requestTimeoutMs: number;

  private constructor(
    token: string,
    apiBaseUrl = HCLOUD_API_BASE,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Construct a client from `HCLOUD_TOKEN` (matches the official Hetzner CLI
   * + Terraform provider convention). Throws `missing_token` if the env var
   * is unset — callers handle the case by falling back to the static
   * auctioned pool.
   */
  static fromEnv(): HetznerCloudClient {
    const token = containersEnv.hetznerCloudToken();
    if (!token) {
      throw new HetznerCloudError(
        "missing_token",
        "Hetzner Cloud API token is not configured. Set HCLOUD_TOKEN to enable elastic node provisioning.",
      );
    }
    return new HetznerCloudClient(token);
  }

  /** Construct a client with an explicit token pinned to the configured Hetzner origin. */
  static withToken(token: string, options: { requestTimeoutMs?: number } = {}): HetznerCloudClient {
    validateToken(token);
    validateRequestTimeout(options.requestTimeoutMs);
    return new HetznerCloudClient(token, HCLOUD_API_BASE, options.requestTimeoutMs);
  }

  /**
   * Construct a loopback-only client for protocol contract tests.
   *
   * This seam is disabled outside the test runtime and cannot redirect a
   * production credential to a caller-selected network origin.
   */
  static withTestTransport(
    token: string,
    options: { apiBaseUrl: string; requestTimeoutMs?: number },
  ): HetznerCloudClient {
    validateToken(token);
    validateRequestTimeout(options.requestTimeoutMs);
    if (process.env.NODE_ENV !== "test") {
      throw new HetznerCloudError(
        "invalid_input",
        "Hetzner test transport is available only while NODE_ENV=test",
      );
    }
    return new HetznerCloudClient(
      token,
      validateLoopbackTestApiBaseUrl(options.apiBaseUrl),
      options.requestTimeoutMs,
    );
  }

  // ----------------------------------------------------------------------
  // Servers
  // ----------------------------------------------------------------------

  async listServers(label?: Record<string, string>): Promise<HetznerServer[]> {
    const params = label ? `?label_selector=${encodeLabelSelector(label)}` : "";
    const basePath = `/servers${params}`;
    const servers: HetznerServer[] = [];
    const serverIds = new Set<number>();
    // Hetzner's unqualified first response is page 1. Seed it so a malformed
    // `next_page: 1` cannot make us issue the same credential-bearing request
    // twice before detecting a pagination cycle.
    const visitedPages = new Set<number>([1]);
    let path = basePath;

    for (let pageCount = 0; pageCount < MAX_LIST_PAGES; pageCount += 1) {
      const data = await this.request<{
        servers: HetznerServer[];
        meta?: { pagination?: { next_page?: number | null } };
      }>("GET", path);
      if (!Array.isArray(data.servers)) {
        throw new HetznerCloudError(
          "server_error",
          "Hetzner Cloud API list servers response is missing the servers array",
        );
      }
      for (const rawServer of data.servers) {
        const server = mapHetznerServer(rawServer);
        if (!Number.isSafeInteger(server.id) || server.id <= 0 || serverIds.has(server.id)) {
          throw new HetznerCloudError(
            "server_error",
            "Hetzner Cloud API list servers response contains an invalid or duplicate server ID",
          );
        }
        serverIds.add(server.id);
        servers.push(server);
      }

      const pagination = data.meta?.pagination;
      if (!pagination || !("next_page" in pagination)) {
        throw new HetznerCloudError(
          "server_error",
          "Hetzner Cloud API list servers response is missing pagination metadata",
        );
      }
      const nextPage = pagination.next_page;
      if (nextPage == null) return servers;
      if (!Number.isSafeInteger(nextPage) || nextPage <= 0 || visitedPages.has(nextPage)) {
        throw new HetznerCloudError(
          "server_error",
          "Hetzner Cloud API list servers response contains invalid pagination",
        );
      }
      visitedPages.add(nextPage);
      path = `${basePath}${basePath.includes("?") ? "&" : "?"}page=${nextPage}`;
    }

    throw new HetznerCloudError(
      "server_error",
      `Hetzner Cloud API list servers exceeded ${MAX_LIST_PAGES} pages`,
    );
  }

  async getServer(serverId: number): Promise<HetznerServer | null> {
    try {
      const data = await this.request<{ server: HetznerServer }>("GET", `/servers/${serverId}`);
      return mapHetznerServer(data.server);
    } catch (err) {
      if (err instanceof HetznerCloudError && err.code === "not_found") return null;
      throw err;
    }
  }

  async createServer(input: CreateServerInput): Promise<ProvisionedServer<HetznerServer>> {
    if (input.userData.length > 32 * 1024) {
      throw new HetznerCloudError(
        "invalid_input",
        `user_data exceeds 32 KiB (${input.userData.length} bytes)`,
      );
    }

    const body: Record<string, unknown> = {
      name: input.name,
      server_type: input.serverType,
      location: input.location,
      image: input.image,
      user_data: input.userData,
      start_after_create: true,
    };
    if (input.sshKeyIds && input.sshKeyIds.length > 0) {
      body.ssh_keys = input.sshKeyIds;
    }
    if (input.networkIds && input.networkIds.length > 0) {
      body.networks = input.networkIds;
    }
    if (input.firewallIds && input.firewallIds.length > 0) {
      body.firewalls = input.firewallIds.map((firewall) => ({ firewall }));
    }
    if (input.labels && Object.keys(input.labels).length > 0) {
      body.labels = input.labels;
    }

    const data = await this.request<{
      server: HetznerServer;
      root_password: string | null;
    }>("POST", "/servers", body);

    logger.info("[hcloud] Created server", {
      serverId: data.server.id,
      name: data.server.name,
      type: input.serverType,
      location: input.location,
    });

    return {
      server: mapHetznerServer(data.server),
      rootPassword: data.root_password,
    };
  }

  async deleteServer(serverId: number): Promise<void> {
    await this.request<unknown>("DELETE", `/servers/${serverId}`);
    logger.info("[hcloud] Deleted server", { serverId });
  }

  async powerOff(serverId: number): Promise<HetznerAction> {
    const data = await this.request<{ action: HetznerAction }>(
      "POST",
      `/servers/${serverId}/actions/poweroff`,
    );
    return data.action;
  }

  async powerOn(serverId: number): Promise<HetznerAction> {
    const data = await this.request<{ action: HetznerAction }>(
      "POST",
      `/servers/${serverId}/actions/poweron`,
    );
    return data.action;
  }

  // ----------------------------------------------------------------------
  // Block storage volumes
  // ----------------------------------------------------------------------

  async listVolumes(filter?: {
    label?: Record<string, string>;
    location?: string;
  }): Promise<HetznerVolume[]> {
    const params: string[] = [];
    if (filter?.label) params.push(`label_selector=${encodeLabelSelector(filter.label)}`);
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    const data = await this.request<{ volumes: HetznerVolume[] }>("GET", `/volumes${qs}`);
    if (filter?.location) {
      return data.volumes.filter((v) => v.location.name === filter.location);
    }
    return data.volumes;
  }

  async getVolume(volumeId: number): Promise<HetznerVolume | null> {
    try {
      const data = await this.request<{ volume: HetznerVolume }>("GET", `/volumes/${volumeId}`);
      return data.volume;
    } catch (err) {
      if (err instanceof HetznerCloudError && err.code === "not_found") return null;
      throw err;
    }
  }

  async createVolume(input: CreateVolumeInput): Promise<HetznerVolume> {
    const body: Record<string, unknown> = {
      name: input.name,
      size: input.sizeGb,
      location: input.location,
      format: input.format ?? "ext4",
    };
    if (input.serverId) body.server = input.serverId;
    if (input.automount === false) body.automount = false;
    if (input.labels && Object.keys(input.labels).length > 0) {
      body.labels = input.labels;
    }

    const data = await this.request<{ volume: HetznerVolume }>("POST", "/volumes", body);
    logger.info("[hcloud] Created volume", {
      volumeId: data.volume.id,
      name: data.volume.name,
      sizeGb: input.sizeGb,
      location: input.location,
    });
    return data.volume;
  }

  async attachVolume(
    volumeId: number,
    serverId: number,
    automount = false,
  ): Promise<HetznerAction> {
    const data = await this.request<{ action: HetznerAction }>(
      "POST",
      `/volumes/${volumeId}/actions/attach`,
      { server: serverId, automount },
    );
    return data.action;
  }

  async detachVolume(volumeId: number): Promise<HetznerAction> {
    const data = await this.request<{ action: HetznerAction }>(
      "POST",
      `/volumes/${volumeId}/actions/detach`,
    );
    return data.action;
  }

  async deleteVolume(volumeId: number): Promise<void> {
    await this.request<unknown>("DELETE", `/volumes/${volumeId}`);
    logger.info("[hcloud] Deleted volume", { volumeId });
  }

  /** Poll an action until it completes (success or error). */
  async waitForAction(actionId: number, timeoutMs = 60_000): Promise<HetznerAction> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = await this.request<{ action: HetznerAction }>("GET", `/actions/${actionId}`);
      if (data.action.status !== "running") return data.action;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new HetznerCloudError(
      "transport_error",
      `Hetzner action ${actionId} did not complete within ${timeoutMs}ms`,
    );
  }

  // ----------------------------------------------------------------------
  // Catalog
  // ----------------------------------------------------------------------

  async listServerTypes(): Promise<HetznerServerType[]> {
    const data = await this.request<{ server_types: HetznerServerType[] }>("GET", "/server_types");
    return data.server_types;
  }

  async listLocations(): Promise<HetznerLocation[]> {
    const data = await this.request<{ locations: HetznerLocation[] }>("GET", "/locations");
    return data.locations;
  }

  async listImages(filter?: {
    type?: string;
    architecture?: "x86" | "arm";
  }): Promise<HetznerImage[]> {
    const params: string[] = [];
    if (filter?.type) params.push(`type=${encodeURIComponent(filter.type)}`);
    if (filter?.architecture)
      params.push(`architecture=${encodeURIComponent(filter.architecture)}`);
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    const data = await this.request<{ images: HetznerImage[] }>("GET", `/images${qs}`);
    return data.images;
  }

  // ----------------------------------------------------------------------
  // Internal HTTP
  // ----------------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (err) {
      throw new HetznerCloudError(
        "transport_error",
        `Hetzner Cloud API ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      throw new HetznerCloudError(
        "server_error",
        `Hetzner Cloud API ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`,
        response.status,
      );
    }

    if (!response.ok) {
      const errorPayload =
        parsed && typeof parsed === "object" && "error" in parsed
          ? (parsed as { error: { code?: string; message?: string } }).error
          : undefined;
      const code = mapStatusToCode(response.status, errorPayload?.code);
      throw new HetznerCloudError(
        code,
        errorPayload?.message ??
          `Hetzner Cloud API ${method} ${path} failed with status ${response.status}`,
        response.status,
        undefined,
        code === "rate_limited" ? parseRetryMetadata(response.headers) : undefined,
      );
    }

    return parsed as T;
  }
}

function mapHetznerServer(server: HetznerServer): HetznerServer {
  const providerFirewalls = server.public_net?.firewalls;
  if (providerFirewalls !== undefined && !Array.isArray(providerFirewalls)) {
    throw new HetznerCloudError(
      "server_error",
      "Hetzner Cloud API server response has malformed firewall attachments",
    );
  }
  const firewallAttachments = (providerFirewalls ?? []).map((firewall) => {
    if (
      !firewall ||
      !Number.isSafeInteger(firewall.id) ||
      firewall.id <= 0 ||
      typeof firewall.status !== "string" ||
      firewall.status.length === 0
    ) {
      throw new HetznerCloudError(
        "server_error",
        "Hetzner Cloud API server response has malformed firewall attachment state",
      );
    }
    return { id: firewall.id, status: firewall.status };
  });
  return {
    ...server,
    // Map provider-specific network state onto the canonical compute seam so
    // autoscaler ownership/drift checks do not need a Hetzner-only cast.
    publicIpv4: server.public_net?.ipv4?.ip ?? server.public_net?.ipv6?.ip ?? null,
    firewallAttachments,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HCLOUD_API_BASE = resolveConfiguredApiBaseUrl(process.env.HCLOUD_API_BASE_URL);

function mapStatusToCode(status: number, apiCode?: string): HetznerCloudErrorCode {
  // Explicit quota/limit apiCodes win over auth-status fallback: Hetzner
  // returns HTTP 403 with body code `limit_reached` (or
  // `resource_limit_exceeded`) when the project's server cap is hit. Without
  // this priority, `status === 403` collapses both "no token" and "quota
  // exhausted" into `missing_token`, which sends operators chasing a
  // non-existent auth bug while the real issue is account quota.
  if (apiCode === "limit_reached" || apiCode === "resource_limit_exceeded") {
    return "quota_exceeded";
  }
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "missing_token";
  if (status === 422 || status === 400) return "invalid_input";
  if (status === 429) return "rate_limited";
  return "server_error";
}

function parseRetryMetadata(headers: Headers): HetznerRetryMetadata {
  const retryAfter = headers.get("retry-after");
  const resetAt = headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset");
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);
  const resetAtEpochSeconds = parseNonNegativeNumber(resetAt);
  return {
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(resetAtEpochSeconds === undefined ? {} : { resetAtEpochSeconds }),
  };
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  const seconds = parseNonNegativeNumber(value);
  if (seconds !== undefined) return seconds;
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
}

function parseNonNegativeNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function validateToken(token: string): void {
  if (!token) {
    throw new HetznerCloudError("missing_token", "Token must be a non-empty string");
  }
}

function validateRequestTimeout(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new HetznerCloudError(
      "invalid_input",
      `requestTimeoutMs must be a positive safe integer no greater than ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
}

function resolveConfiguredApiBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return OFFICIAL_HCLOUD_API_BASE;
  if (process.env.NODE_ENV === "production") {
    throw new HetznerCloudError(
      "invalid_input",
      "HCLOUD_API_BASE_URL cannot override the pinned Hetzner origin in production",
    );
  }
  return validateLoopbackTestApiBaseUrl(value);
}

function validateLoopbackTestApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    // error-policy:J3 Reject an untrusted test transport origin explicitly.
    throw new HetznerCloudError(
      "invalid_input",
      "Hetzner test API base must be a valid loopback URL",
      undefined,
      cause,
    );
  }
  const isLoopbackHost =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (
    !isLoopbackHost ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new HetznerCloudError(
      "invalid_input",
      "Hetzner test API base must be an uncredentialed HTTP(S) loopback origin without query or fragment",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function encodeLabelSelector(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join(",");
}

let cachedClient: HetznerCloudClient | null = null;

/** Singleton accessor; throws if HCLOUD_TOKEN is not configured. */
export function getHetznerCloudClient(): HetznerCloudClient {
  if (!cachedClient) cachedClient = HetznerCloudClient.fromEnv();
  return cachedClient;
}

/** Whether the elastic-provisioning surface is configured. */
export function isHetznerCloudConfigured(): boolean {
  return !!containersEnv.hetznerCloudToken();
}
