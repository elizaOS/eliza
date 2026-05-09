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

import { containersEnv } from "@/lib/config/containers-env";
import { logger } from "@/lib/utils/logger";

const HCLOUD_API_BASE = "https://api.hetzner.cloud/v1";
const REQUEST_TIMEOUT_MS = 30_000;

export type HetznerCloudErrorCode =
  | "missing_token"
  | "invalid_input"
  | "not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "server_error"
  | "transport_error";

export class HetznerCloudError extends Error {
  constructor(
    public readonly code: HetznerCloudErrorCode,
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
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
  };
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

export interface CreateVolumeInput {
  name: string;
  /** Volume size in GiB (Hetzner allocates whole GiB). */
  sizeGb: number;
  /** Hetzner location code (must match the server it will attach to). */
  location: string;
  /** Filesystem format applied at creation time. Default `ext4`. */
  format?: "ext4" | "xfs";
  /** Optional server id to attach to immediately on create. */
  serverId?: number;
  /** Whether Hetzner should attempt automatic mount via cloud-init helpers. */
  automount?: boolean;
  labels?: Record<string, string>;
}

export interface CreateServerInput {
  name: string;
  serverType: string;
  /** Datacenter / location shorthand (e.g. "fsn1", "nbg1", "hel1", "ash"). */
  location: string;
  /** Image id or canonical name (e.g. "ubuntu-24.04"). */
  image: string;
  /**
   * Cloud-init / user_data script. Must be ≤32 KiB. The default node
   * bootstrap script is provided by `buildContainerNodeUserData()`.
   */
  userData: string;
  /** SSH key IDs (numeric). The control plane's deploy key should be one of these. */
  sshKeyIds?: number[];
  /** Network IDs to attach the server to (private networking). */
  networkIds?: number[];
  /** Hetzner Cloud labels — free-form key/value map. */
  labels?: Record<string, string>;
}

export interface ProvisionedServer {
  server: HetznerServer;
  rootPassword: string | null;
}

// ---------------------------------------------------------------------------
// HetznerCloudClient
// ---------------------------------------------------------------------------

export class HetznerCloudClient {
  private readonly token: string;

  private constructor(token: string) {
    this.token = token;
  }

  /**
   * Construct a client from `HCLOUD_TOKEN`, `HETZNER_CLOUD_TOKEN`, or
   * `HETZNER_CLOUD_API_KEY`.
   * Throws `missing_token` if neither env var is set — callers handle
   * the case by falling back to the static auctioned pool.
   */
  static fromEnv(): HetznerCloudClient {
    const token = containersEnv.hetznerCloudToken();
    if (!token) {
      throw new HetznerCloudError(
        "missing_token",
        "Hetzner Cloud API token is not configured. Set HCLOUD_TOKEN or HETZNER_CLOUD_API_KEY to enable elastic node provisioning.",
      );
    }
    return new HetznerCloudClient(token);
  }

  /** Construct a client with an explicit token (tests, multi-tenant). */
  static withToken(token: string): HetznerCloudClient {
    if (!token) {
      throw new HetznerCloudError("missing_token", "Token must be a non-empty string");
    }
    return new HetznerCloudClient(token);
  }

  // ----------------------------------------------------------------------
  // Servers
  // ----------------------------------------------------------------------

  async listServers(label?: Record<string, string>): Promise<HetznerServer[]> {
    const params = label ? `?label_selector=${encodeLabelSelector(label)}` : "";
    const data = await this.request<{ servers: HetznerServer[] }>("GET", `/servers${params}`);
    return data.servers;
  }

  async getServer(serverId: number): Promise<HetznerServer | null> {
    try {
      const data = await this.request<{ server: HetznerServer }>("GET", `/servers/${serverId}`);
      return data.server;
    } catch (err) {
      if (err instanceof HetznerCloudError && err.code === "not_found") return null;
      throw err;
    }
  }

  async createServer(input: CreateServerInput): Promise<ProvisionedServer> {
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

    return { server: data.server, rootPassword: data.root_password };
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
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${HCLOUD_API_BASE}${path}`, {
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
      );
    }

    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStatusToCode(status: number, apiCode?: string): HetznerCloudErrorCode {
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "missing_token";
  if (status === 422 || status === 400) return "invalid_input";
  if (status === 429) return "rate_limited";
  if (apiCode === "limit_reached" || apiCode === "resource_limit_exceeded") {
    return "quota_exceeded";
  }
  return "server_error";
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
