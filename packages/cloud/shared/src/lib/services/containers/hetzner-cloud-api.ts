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
const LIFECYCLE_TIMEOUT_MS = 60_000;
const ACTION_POLL_INTERVAL_MS = 1_500;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const NO_CONTENT = Symbol("hetzner-no-content");

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
  resources?: Array<{ id: number; type: string }>;
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
  private readonly lifecycleTimeoutMs: number;

  private constructor(
    token: string,
    apiBaseUrl = HCLOUD_API_BASE,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    lifecycleTimeoutMs = LIFECYCLE_TIMEOUT_MS,
  ) {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs = requestTimeoutMs;
    this.lifecycleTimeoutMs = lifecycleTimeoutMs;
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
  static withToken(
    token: string,
    options: { requestTimeoutMs?: number; lifecycleTimeoutMs?: number } = {},
  ): HetznerCloudClient {
    validateToken(token);
    validateRequestTimeout(options.requestTimeoutMs);
    validateRequestTimeout(options.lifecycleTimeoutMs, "lifecycleTimeoutMs");
    return new HetznerCloudClient(
      token,
      HCLOUD_API_BASE,
      options.requestTimeoutMs,
      options.lifecycleTimeoutMs,
    );
  }

  /**
   * Construct a loopback-only client for protocol contract tests.
   *
   * This seam is disabled outside the test runtime and cannot redirect a
   * production credential to a caller-selected network origin.
   */
  static withTestTransport(
    token: string,
    options: {
      apiBaseUrl: string;
      requestTimeoutMs?: number;
      lifecycleTimeoutMs?: number;
    },
  ): HetznerCloudClient {
    validateToken(token);
    validateRequestTimeout(options.requestTimeoutMs);
    validateRequestTimeout(options.lifecycleTimeoutMs, "lifecycleTimeoutMs");
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
      options.lifecycleTimeoutMs,
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

    while (true) {
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
  }

  async getServer(serverId: number): Promise<HetznerServer | null> {
    validateResourceId(serverId, "serverId");
    return this.getServerWithin(serverId, deadlineAfter(this.requestTimeoutMs));
  }

  private async getServerWithin(serverId: number, deadline: number): Promise<HetznerServer | null> {
    try {
      const data = requireEnvelope(
        await this.request<unknown>("GET", `/servers/${serverId}`, undefined, deadline),
        "server readback",
      );
      const server = mapHetznerServer(
        requireObject(data.server, "server readback resource") as unknown as HetznerServer,
      );
      assertExactResourceId(server.id, serverId, "server");
      return server;
    } catch (err) {
      // error-policy:J4 exact resource absence is the designed by-id read
      // result; every other provider or transport failure remains exceptional.
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

    const deadline = deadlineAfter(this.lifecycleTimeoutMs);
    const data = requireEnvelope(
      await this.request<unknown>("POST", "/servers", body, deadline),
      "create server",
    );
    const createdServer = requireObject(data.server, "created server");
    const serverId = requireResourceId(createdServer.id, "created server");
    if (data.root_password !== null && typeof data.root_password !== "string") {
      throw malformedEnvelope("create server root_password is invalid");
    }
    await this.settleReturnedActions(
      data.action,
      data.next_actions,
      deadline,
      { id: serverId, type: "server" },
      true,
    );
    const server = await this.getServerWithin(serverId, deadline);
    if (!server || server.status !== "running") {
      throw new HetznerCloudError(
        "server_error",
        `Hetzner Cloud API created server ${serverId} but exact readback was not running`,
      );
    }

    logger.info("[hcloud] Created server", {
      serverId,
      name: server.name,
      type: input.serverType,
      location: input.location,
    });

    return {
      server,
      rootPassword: data.root_password,
    };
  }

  async deleteServer(serverId: number): Promise<void> {
    validateResourceId(serverId, "serverId");
    const deadline = deadlineAfter(this.lifecycleTimeoutMs);
    let data: Record<string, unknown>;
    try {
      data = requireEnvelope(
        await this.request<unknown>("DELETE", `/servers/${serverId}`, undefined, deadline),
        "delete server",
      );
    } catch (error) {
      // error-policy:J4 an exact target 404 is the provider's explicit
      // idempotent-absence result; action-poll 404s are never handled here.
      if (error instanceof HetznerCloudError && error.code === "not_found") return;
      throw error;
    }
    await this.settleReturnedActions(
      data.action,
      Object.hasOwn(data, "next_actions") ? data.next_actions : [],
      deadline,
      { id: serverId, type: "server" },
      true,
    );
    if ((await this.getServerWithin(serverId, deadline)) !== null) {
      throw new HetznerCloudError(
        "server_error",
        `Hetzner Cloud API delete action completed but server ${serverId} still exists`,
      );
    }
    logger.info("[hcloud] Deleted server", { serverId });
  }

  async powerOff(serverId: number): Promise<HetznerAction> {
    validateResourceId(serverId, "serverId");
    const data = requireEnvelope(
      await this.request<unknown>("POST", `/servers/${serverId}/actions/poweroff`),
      "power-off server",
    );
    return requireAcceptedAction(data.action, {
      expectedResource: { id: serverId, type: "server" },
      requireResources: true,
    });
  }

  async powerOn(serverId: number): Promise<HetznerAction> {
    validateResourceId(serverId, "serverId");
    const data = requireEnvelope(
      await this.request<unknown>("POST", `/servers/${serverId}/actions/poweron`),
      "power-on server",
    );
    return requireAcceptedAction(data.action, {
      expectedResource: { id: serverId, type: "server" },
      requireResources: true,
    });
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
    validateResourceId(volumeId, "volumeId");
    return this.getVolumeWithin(volumeId, deadlineAfter(this.requestTimeoutMs));
  }

  private async getVolumeWithin(volumeId: number, deadline: number): Promise<HetznerVolume | null> {
    try {
      const data = requireEnvelope(
        await this.request<unknown>("GET", `/volumes/${volumeId}`, undefined, deadline),
        "volume readback",
      );
      const volume = requireObject(
        data.volume,
        "volume readback resource",
      ) as unknown as HetznerVolume;
      assertExactResourceId(volume.id, volumeId, "volume");
      return volume;
    } catch (err) {
      // error-policy:J4 exact resource absence is the designed by-id read
      // result; every other provider or transport failure remains exceptional.
      if (err instanceof HetznerCloudError && err.code === "not_found") return null;
      throw err;
    }
  }

  async createVolume(input: CreateVolumeInput): Promise<HetznerVolume> {
    if (input.serverId !== undefined) {
      validateResourceId(input.serverId, "serverId");
    }
    if (input.automount === true && input.serverId === undefined) {
      throw new HetznerCloudError(
        "invalid_input",
        "Hetzner createVolume automount requires serverId",
      );
    }
    const body: Record<string, unknown> = {
      name: input.name,
      size: input.sizeGb,
      format: input.format ?? "ext4",
    };
    if (input.serverId === undefined) body.location = input.location;
    else body.server = input.serverId;
    if (input.automount !== undefined) body.automount = input.automount;
    if (input.labels && Object.keys(input.labels).length > 0) {
      body.labels = input.labels;
    }

    const deadline = deadlineAfter(this.lifecycleTimeoutMs);
    const data = requireEnvelope(
      await this.request<unknown>("POST", "/volumes", body, deadline),
      "create volume",
    );
    const createdVolume = requireObject(data.volume, "created volume");
    const volumeId = requireResourceId(createdVolume.id, "created volume");
    await this.settleReturnedActions(
      data.action,
      data.next_actions,
      deadline,
      { id: volumeId, type: "volume" },
      false,
    );
    const volume = await this.getVolumeWithin(volumeId, deadline);
    if (!volume || volume.status !== "available") {
      throw new HetznerCloudError(
        "server_error",
        `Hetzner Cloud API created volume ${volumeId} but exact readback was not available`,
      );
    }
    const expectedServer = input.serverId ?? null;
    if (volume.server !== expectedServer) {
      throw new HetznerCloudError(
        "server_error",
        `Hetzner Cloud API created volume ${volumeId} with unexpected server attachment`,
      );
    }
    const hasDevice = typeof volume.linux_device === "string" && volume.linux_device.length > 0;
    if (
      (expectedServer === null && volume.linux_device !== null) ||
      (expectedServer !== null && !hasDevice)
    ) {
      throw new HetznerCloudError(
        "server_error",
        `Hetzner Cloud API created volume ${volumeId} with inconsistent device state`,
      );
    }
    logger.info("[hcloud] Created volume", {
      volumeId,
      name: volume.name,
      sizeGb: input.sizeGb,
      location: input.location,
    });
    return volume;
  }

  async attachVolume(
    volumeId: number,
    serverId: number,
    automount = false,
  ): Promise<HetznerAction> {
    validateResourceId(volumeId, "volumeId");
    validateResourceId(serverId, "serverId");
    const data = requireEnvelope(
      await this.request<unknown>("POST", `/volumes/${volumeId}/actions/attach`, {
        server: serverId,
        automount,
      }),
      "attach volume",
    );
    return requireAcceptedAction(data.action, {
      expectedResource: { id: volumeId, type: "volume" },
      requireResources: true,
    });
  }

  async detachVolume(volumeId: number): Promise<HetznerAction> {
    validateResourceId(volumeId, "volumeId");
    const data = requireEnvelope(
      await this.request<unknown>("POST", `/volumes/${volumeId}/actions/detach`),
      "detach volume",
    );
    return requireAcceptedAction(data.action, {
      expectedResource: { id: volumeId, type: "volume" },
      requireResources: true,
    });
  }

  async deleteVolume(volumeId: number): Promise<void> {
    validateResourceId(volumeId, "volumeId");
    const deadline = deadlineAfter(this.lifecycleTimeoutMs);
    let deleteResponse: unknown | typeof NO_CONTENT;
    try {
      deleteResponse = await this.request<unknown>(
        "DELETE",
        `/volumes/${volumeId}`,
        undefined,
        deadline,
        true,
      );
    } catch (error) {
      // error-policy:J4 an exact target 404 is the provider's explicit
      // idempotent-absence result.
      if (error instanceof HetznerCloudError && error.code === "not_found") return;
      throw error;
    }
    if (deleteResponse !== NO_CONTENT) {
      const data = requireEnvelope(deleteResponse, "delete volume");
      await this.settleReturnedActions(
        data.action,
        Object.hasOwn(data, "next_actions") ? data.next_actions : [],
        deadline,
        { id: volumeId, type: "volume" },
        true,
      );
    }
    if ((await this.getVolumeWithin(volumeId, deadline)) !== null) {
      throw new HetznerCloudError(
        "server_error",
        `Hetzner Cloud API delete completed but volume ${volumeId} still exists`,
      );
    }
    logger.info("[hcloud] Deleted volume", { volumeId });
  }

  /** Poll an action until terminal success, rejecting terminal provider errors. */
  async waitForAction(actionId: number, timeoutMs = 60_000): Promise<HetznerAction> {
    validateResourceId(actionId, "actionId");
    validateRequestTimeout(timeoutMs, "timeoutMs");
    return this.waitForActionUntil(actionId, deadlineAfter(timeoutMs));
  }

  private async waitForActionUntil(
    actionId: number,
    deadline: number,
    expectedResource?: { id: number; type: string },
  ): Promise<HetznerAction> {
    while (Date.now() < deadline) {
      const data = requireEnvelope(
        await this.request<unknown>("GET", `/actions/${actionId}`, undefined, deadline),
        "action readback",
      );
      const action = parseActionEnvelope(data.action, {
        expectedId: actionId,
        expectedResource,
        requireResources: true,
      });
      if (action.status === "success") return action;
      if (action.status === "error") throw actionFailure(action);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(ACTION_POLL_INTERVAL_MS, remaining)),
      );
    }
    throw new HetznerCloudError(
      "transport_error",
      `Hetzner action ${actionId} did not complete before the operation deadline`,
    );
  }

  private async settleReturnedActions(
    primary: unknown,
    nextActionsValue: unknown,
    deadline: number,
    expectedPrimaryResource: { id: number; type: string },
    primaryRequired: boolean,
  ): Promise<void> {
    if (!Array.isArray(nextActionsValue)) {
      throw malformedEnvelope("lifecycle response is missing next_actions");
    }
    const actions: Array<{
      action: HetznerAction;
      expectedResource?: { id: number; type: string };
    }> = [];
    if (primary === null || primary === undefined) {
      if (primaryRequired) throw malformedEnvelope("lifecycle response is missing action");
    } else {
      actions.push({
        action: parseActionEnvelope(primary, {
          expectedResource: expectedPrimaryResource,
          requireResources: true,
        }),
        expectedResource: expectedPrimaryResource,
      });
    }
    for (const rawAction of nextActionsValue) {
      actions.push({
        action: parseActionEnvelope(rawAction, { requireResources: true }),
      });
    }
    const actionIds = new Set<number>();
    for (const entry of actions) {
      if (actionIds.has(entry.action.id)) {
        throw malformedEnvelope("lifecycle response contains a duplicate action ID");
      }
      actionIds.add(entry.action.id);
      if (entry.action.status === "error") throw actionFailure(entry.action);
      if (entry.action.status === "running") {
        await this.waitForActionUntil(entry.action.id, deadline, entry.expectedResource);
      }
    }
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
    deadline?: number,
  ): Promise<T>;
  private async request<T>(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    body: unknown,
    deadline: number,
    distinguishNoContent: true,
  ): Promise<T | typeof NO_CONTENT>;
  private async request<T>(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    body?: unknown,
    deadline = deadlineAfter(this.requestTimeoutMs),
    distinguishNoContent = false,
  ): Promise<T | typeof NO_CONTENT> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new HetznerCloudError(
        "transport_error",
        `Hetzner Cloud API ${method} ${path} exceeded its operation deadline`,
      );
    }
    const requestDeadline = Date.now() + Math.min(this.requestTimeoutMs, remaining);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), requestDeadline - Date.now());
    try {
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      assertRequestWithinDeadline(method, path, requestDeadline);

      if (response.status === 204) {
        return distinguishNoContent ? NO_CONTENT : (undefined as T);
      }

      const text = await response.text();
      assertRequestWithinDeadline(method, path, requestDeadline);
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        // error-policy:J3 provider bytes must parse as the declared JSON
        // envelope; malformed payloads never become successful defaults.
        throw new HetznerCloudError(
          "server_error",
          `Hetzner Cloud API ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`,
          response.status,
        );
      }
      assertRequestWithinDeadline(method, path, requestDeadline);

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
    } catch (error) {
      if (error instanceof HetznerCloudError) throw error;
      // error-policy:J2 preserve the underlying fetch or body-read failure at
      // the typed provider transport boundary.
      throw new HetznerCloudError(
        "transport_error",
        `Hetzner Cloud API ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ActionEnvelopeOptions {
  expectedId?: number;
  expectedResource?: { id: number; type: string };
  requireResources?: boolean;
}

function requireEnvelope(value: unknown, operation: string): Record<string, unknown> {
  return requireObject(value, `${operation} response`);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedEnvelope(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function parseActionEnvelope(value: unknown, options: ActionEnvelopeOptions = {}): HetznerAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedEnvelope("action is not an object");
  }
  const action = value as Partial<HetznerAction>;
  if (!Number.isSafeInteger(action.id) || (action.id as number) <= 0) {
    throw malformedEnvelope("action has an invalid ID");
  }
  if (options.expectedId !== undefined && action.id !== options.expectedId) {
    throw malformedEnvelope("action readback returned a different ID");
  }
  if (typeof action.command !== "string" || action.command.trim() === "") {
    throw malformedEnvelope("action has an invalid command");
  }
  if (action.status !== "running" && action.status !== "success" && action.status !== "error") {
    throw malformedEnvelope("action has an invalid status");
  }
  if (
    !Number.isFinite(action.progress) ||
    !Number.isInteger(action.progress) ||
    (action.progress as number) < 0 ||
    (action.progress as number) > 100
  ) {
    throw malformedEnvelope("action has invalid progress");
  }
  if (action.status === "error") {
    if (
      !action.error ||
      typeof action.error.code !== "string" ||
      action.error.code.trim() === "" ||
      typeof action.error.message !== "string" ||
      action.error.message.trim() === ""
    ) {
      throw malformedEnvelope("failed action is missing its provider error");
    }
  } else if (action.error !== null) {
    throw malformedEnvelope("non-failed action contains an error");
  }

  const resources = action.resources;
  if (options.requireResources && !Array.isArray(resources)) {
    throw malformedEnvelope("action is missing resource bindings");
  }
  if (resources !== undefined) {
    if (!Array.isArray(resources)) {
      throw malformedEnvelope("action has malformed resource bindings");
    }
    for (const resource of resources) {
      if (
        !resource ||
        !Number.isSafeInteger(resource.id) ||
        resource.id <= 0 ||
        typeof resource.type !== "string" ||
        resource.type.trim() === ""
      ) {
        throw malformedEnvelope("action has malformed resource bindings");
      }
    }
  }
  if (
    options.expectedResource &&
    !resources?.some(
      (resource) =>
        resource.id === options.expectedResource?.id &&
        resource.type === options.expectedResource.type,
    )
  ) {
    throw malformedEnvelope("action is not bound to the exact requested resource");
  }
  return action as HetznerAction;
}

function requireAcceptedAction(value: unknown, options: ActionEnvelopeOptions): HetznerAction {
  const action = parseActionEnvelope(value, options);
  if (action.status === "error") throw actionFailure(action);
  return action;
}

function actionFailure(action: HetznerAction): HetznerCloudError {
  return new HetznerCloudError(
    "server_error",
    `Hetzner action ${action.id} failed (${action.error?.code}): ${action.error?.message}`,
  );
}

function malformedEnvelope(detail: string): HetznerCloudError {
  return new HetznerCloudError(
    "server_error",
    `Hetzner Cloud API returned a malformed lifecycle response: ${detail}`,
  );
}

function validateResourceId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HetznerCloudError("invalid_input", `${field} must be a positive safe integer`);
  }
}

function requireResourceId(value: unknown, resource: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw malformedEnvelope(`${resource} has an invalid ID`);
  }
  return value as number;
}

function assertExactResourceId(value: unknown, expected: number, resource: string): void {
  if (value !== expected) {
    throw malformedEnvelope(`${resource} readback returned a different ID`);
  }
}

function deadlineAfter(timeoutMs: number): number {
  return Date.now() + timeoutMs;
}

function assertRequestWithinDeadline(
  method: "GET" | "POST" | "DELETE" | "PUT",
  path: string,
  deadline: number,
): void {
  if (Date.now() >= deadline) {
    throw new HetznerCloudError(
      "transport_error",
      `Hetzner Cloud API ${method} ${path} exceeded its request deadline`,
    );
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

function validateRequestTimeout(value: number | undefined, field = "requestTimeoutMs"): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new HetznerCloudError(
      "invalid_input",
      `${field} must be a positive safe integer no greater than ${MAX_REQUEST_TIMEOUT_MS}`,
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
