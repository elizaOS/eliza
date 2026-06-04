/**
 * DigitalOcean compute provider.
 *
 * Implements the shared `ComputeProvider` seam over the DigitalOcean v2 REST
 * API (https://docs.digitalocean.com/reference/api/, base
 * `https://api.digitalocean.com/v2`). It is the DO analog of
 * `HetznerCloudClient`: a thin, SDK-free wrapper that the autoscaler and
 * warm-pool scheduler use to provision and decommission droplets that join the
 * Docker pool, plus the block-storage and read-only catalog surface.
 *
 * Design notes specific to DO (vs Hetzner):
 *
 *  - **No synchronous "ready" on create.** `POST /droplets` returns a droplet
 *    in status `new`; the droplet boots out of band. `createServer` therefore
 *    returns a `ProvisionedServer` immediately (status `new`) and callers poll
 *    `getServer` — identical contract to Hetzner.
 *  - **No root password.** DO never returns a root password on create, so
 *    `ProvisionedServer.rootPassword` is always `null`.
 *  - **Volume ids are UUID strings**, not numbers. Droplet / action / image
 *    ids are numbers; region / size identifiers are slugs (strings). The
 *    `ComputeProvider` volume methods declare `number` params; we widen the
 *    DO overrides to `number | string` (sound: accepting a superset of inputs
 *    is contravariantly safe and satisfies `implements`) and stringify
 *    internally.
 *  - **Status vocabulary normalization.** DO droplet statuses
 *    (`new`/`active`/`off`/`archive`) and action statuses
 *    (`in-progress`/`completed`/`errored`) differ from Hetzner's. We normalize
 *    the `Compute*` outputs to the Hetzner vocabulary
 *    (`active→running`, `completed→success`, `errored→error`, …) so the DO
 *    provider is a true drop-in for any consumer that ever compares a status
 *    literal.
 *
 * Construction is fully injectable for unit testing: an injected `fetch` and a
 * lazy token getter (env `DO_API_TOKEN` || `DIGITALOCEAN_TOKEN`). The token is
 * resolved per request, so tests can set it after construction and a request
 * only throws `missing_token` when it actually fires.
 */

import { logger } from "../../utils/logger";
import type {
  ComputeAction,
  ComputeImage,
  ComputeLocation,
  ComputeProvider,
  ComputeServer,
  ComputeServerType,
  ComputeVolume,
  CreateServerInput,
  CreateVolumeInput,
  ProvisionedServer,
} from "./compute-provider";

// Re-export the canonical input/result types so importers can pull them from
// this module too (parity with `hetzner-cloud-api`).
export type { CreateServerInput, CreateVolumeInput, ProvisionedServer } from "./compute-provider";

const DO_API_BASE = process.env.DO_API_BASE_URL ?? "https://api.digitalocean.com/v2";
const REQUEST_TIMEOUT_MS = 30_000;
/** DO list endpoints default to per_page=20; pull a generous page to avoid silent truncation. */
const LIST_PER_PAGE = 200;

export type DigitalOceanErrorCode =
  | "missing_token"
  | "invalid_input"
  | "not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "server_error"
  | "transport_error";

export class DigitalOceanComputeError extends Error {
  constructor(
    public readonly code: DigitalOceanErrorCode,
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DigitalOceanComputeError";
  }
}

// ---------------------------------------------------------------------------
// DigitalOcean wire shapes (the subset we read)
// ---------------------------------------------------------------------------

/** DO droplet status enum. */
export type DropletStatus = "new" | "active" | "off" | "archive";

export interface DODroplet {
  id: number;
  name: string;
  status: DropletStatus;
  created_at: string;
  networks?: {
    v4?: Array<{
      ip_address: string;
      type: "public" | "private";
      netmask?: string;
      gateway?: string;
    }>;
    v6?: Array<{ ip_address: string; type: "public" | "private" }>;
  };
  size_slug?: string;
  region?: { slug: string; name: string };
  tags?: string[];
}

/** DO action status enum. */
export type DOActionStatus = "in-progress" | "completed" | "errored";

export interface DOAction {
  id: number;
  status: DOActionStatus;
  type: string;
  resource_id?: number | null;
  resource_type?: string;
  region_slug?: string | null;
}

export interface DOVolume {
  id: string;
  name: string;
  size_gigabytes: number;
  region: { slug: string; name: string };
  droplet_ids: number[];
  filesystem_type?: string | null;
  tags?: string[];
}

export interface DOSize {
  slug: string;
  vcpus: number;
  memory: number; // MiB
  disk: number;
  available?: boolean;
}

export interface DORegion {
  slug: string;
  name: string;
  available?: boolean;
}

export interface DOImage {
  id: number;
  name: string | null;
  slug: string | null;
  type: string;
}

// ---------------------------------------------------------------------------
// Compute* result shapes specialized for DO (structural subtypes)
// ---------------------------------------------------------------------------

/** A `ComputeServer` carrying the DO-native fields the runtime reads (IPs). */
export interface DOComputeServer extends ComputeServer {
  id: number;
  /**
   * Raw DO droplet status (`new`/`active`/`off`/`archive`) before
   * normalization. `status` is mapped to the Hetzner vocabulary; this field
   * preserves the provider-native value for callers that need it.
   */
  rawStatus: DropletStatus | string;
  /** Public IPv4, if the droplet has booted far enough to have one. */
  publicIp?: string;
  /** Private IPv4 (VPC), if attached. */
  privateIp?: string;
}

/** A `ComputeVolume` whose id is the DO UUID string. */
export interface DOComputeVolume extends ComputeVolume {
  id: string;
}

// ---------------------------------------------------------------------------
// Token getter
// ---------------------------------------------------------------------------

/** Resolves the DO API token lazily. Returns undefined when unconfigured. */
export type DigitalOceanTokenGetter = () => string | undefined;

/** Default token getter: `DO_API_TOKEN` || `DIGITALOCEAN_TOKEN`. */
export function defaultDigitalOceanTokenGetter(): string | undefined {
  const raw = process.env.DO_API_TOKEN ?? process.env.DIGITALOCEAN_TOKEN;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface DigitalOceanComputeProviderOptions {
  /** Injected fetch (defaults to the global). */
  fetch?: typeof globalThis.fetch;
  /** Lazy token getter (defaults to `DO_API_TOKEN` || `DIGITALOCEAN_TOKEN`). */
  tokenGetter?: DigitalOceanTokenGetter;
  /** Override the API base (defaults to the public v2 endpoint). */
  apiBase?: string;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /** Sleep used between `waitForAction` polls (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// DigitalOceanComputeProvider
// ---------------------------------------------------------------------------

export class DigitalOceanComputeProvider implements ComputeProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly tokenGetter: DigitalOceanTokenGetter;
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DigitalOceanComputeProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.tokenGetter = options.tokenGetter ?? defaultDigitalOceanTokenGetter;
    this.apiBase = options.apiBase ?? DO_API_BASE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Convenience constructor with an explicit token (tests / multi-tenant). */
  static withToken(
    token: string,
    options: Omit<DigitalOceanComputeProviderOptions, "tokenGetter"> = {},
  ): DigitalOceanComputeProvider {
    if (!token) {
      throw new DigitalOceanComputeError("missing_token", "Token must be a non-empty string");
    }
    return new DigitalOceanComputeProvider({ ...options, tokenGetter: () => token });
  }

  // ----------------------------------------------------------------------
  // Servers (droplets)
  // ----------------------------------------------------------------------

  async listServers(labels?: Record<string, string>): Promise<DOComputeServer[]> {
    // DO has no Hetzner-style label selector; tags are the closest analog and
    // are filtered server-side via `tag_name` (single tag only). We send the
    // first label *value* as a tag when a label map is provided, then filter
    // the rest client-side against droplet tags.
    const params: string[] = [`per_page=${LIST_PER_PAGE}`];
    const labelEntries = labels ? Object.entries(labels) : [];
    const firstLabel = labelEntries[0];
    if (firstLabel) {
      params.push(`tag_name=${encodeURIComponent(firstLabel[1])}`);
    }
    const qs = `?${params.join("&")}`;
    const data = await this.request<{ droplets: DODroplet[] }>("GET", `/droplets${qs}`);
    let droplets = data.droplets;
    if (labelEntries.length > 0) {
      const required = labelEntries.map(([, v]) => v);
      droplets = droplets.filter((d) => {
        const tags = d.tags ?? [];
        return required.every((v) => tags.includes(v));
      });
    }
    return droplets.map((d) => mapDroplet(d));
  }

  async getServer(id: number | string): Promise<DOComputeServer | null> {
    try {
      const data = await this.request<{ droplet: DODroplet }>("GET", `/droplets/${id}`);
      return mapDroplet(data.droplet);
    } catch (err) {
      if (err instanceof DigitalOceanComputeError && err.code === "not_found") return null;
      throw err;
    }
  }

  async createServer(input: CreateServerInput): Promise<ProvisionedServer<DOComputeServer>> {
    // DO caps user_data at 64 KiB; keep the same guard shape as Hetzner.
    if (input.userData.length > 64 * 1024) {
      throw new DigitalOceanComputeError(
        "invalid_input",
        `user_data exceeds 64 KiB (${input.userData.length} bytes)`,
      );
    }

    const body: Record<string, unknown> = {
      name: input.name,
      region: input.location,
      size: input.serverType,
      image: dropletImage(input.image),
      user_data: input.userData,
    };
    if (input.sshKeyIds && input.sshKeyIds.length > 0) {
      body.ssh_keys = input.sshKeyIds;
    }
    // DO labels → tags (values only; DO tags are flat strings).
    if (input.labels && Object.keys(input.labels).length > 0) {
      body.tags = Object.values(input.labels);
    }
    // Private networking is always on within the region's default VPC; an
    // explicit VPC can be selected via the first networkId (DO uses a single
    // `vpc_uuid` string, not a list).
    if (input.networkIds && input.networkIds.length > 0) {
      const first = input.networkIds[0];
      if (first !== undefined) body.vpc_uuid = String(first);
    }

    const data = await this.request<{ droplet: DODroplet }>("POST", "/droplets", body);

    logger.info("[do] Created droplet", {
      serverId: data.droplet.id,
      name: data.droplet.name,
      size: input.serverType,
      region: input.location,
    });

    // DO never returns a root password.
    return { server: mapDroplet(data.droplet), rootPassword: null };
  }

  async deleteServer(id: number | string): Promise<void> {
    try {
      await this.request<unknown>("DELETE", `/droplets/${id}`);
      logger.info("[do] Deleted droplet", { serverId: id });
    } catch (err) {
      // 404 on delete is success (already gone).
      if (err instanceof DigitalOceanComputeError && err.code === "not_found") return;
      throw err;
    }
  }

  async powerOff(id: number | string): Promise<ComputeAction> {
    return this.dropletAction(id, "power_off");
  }

  async powerOn(id: number | string): Promise<ComputeAction> {
    return this.dropletAction(id, "power_on");
  }

  private async dropletAction(id: number | string, type: string): Promise<ComputeAction> {
    const data = await this.request<{ action: DOAction }>("POST", `/droplets/${id}/actions`, {
      type,
    });
    return mapAction(data.action);
  }

  // ----------------------------------------------------------------------
  // Block storage volumes
  // ----------------------------------------------------------------------

  async listVolumes(filter?: {
    label?: Record<string, string>;
    location?: string;
  }): Promise<DOComputeVolume[]> {
    const params: string[] = [`per_page=${LIST_PER_PAGE}`];
    if (filter?.location) params.push(`region=${encodeURIComponent(filter.location)}`);
    const qs = `?${params.join("&")}`;
    const data = await this.request<{ volumes: DOVolume[] }>("GET", `/volumes${qs}`);
    let volumes = data.volumes;
    if (filter?.label) {
      const required = Object.values(filter.label);
      volumes = volumes.filter((v) => {
        const tags = v.tags ?? [];
        return required.every((t) => tags.includes(t));
      });
    }
    return volumes.map((v) => mapVolume(v));
  }

  async getVolume(id: number | string): Promise<DOComputeVolume | null> {
    try {
      const data = await this.request<{ volume: DOVolume }>("GET", `/volumes/${id}`);
      return mapVolume(data.volume);
    } catch (err) {
      if (err instanceof DigitalOceanComputeError && err.code === "not_found") return null;
      throw err;
    }
  }

  async createVolume(input: CreateVolumeInput): Promise<DOComputeVolume> {
    const body: Record<string, unknown> = {
      name: input.name,
      size_gigabytes: input.sizeGb,
      region: input.location,
      // DO maps ext4/xfs to its filesystem_type field.
      filesystem_type: input.format ?? "ext4",
    };
    if (input.labels && Object.keys(input.labels).length > 0) {
      body.tags = Object.values(input.labels);
    }
    const data = await this.request<{ volume: DOVolume }>("POST", "/volumes", body);
    logger.info("[do] Created volume", {
      volumeId: data.volume.id,
      name: data.volume.name,
      sizeGb: input.sizeGb,
      region: input.location,
    });
    return mapVolume(data.volume);
  }

  async attachVolume(volumeId: number | string, serverId: number | string): Promise<ComputeAction> {
    // DO attaches by name OR id at /volumes/{id}/actions with droplet_id.
    const data = await this.request<{ action: DOAction }>("POST", `/volumes/${volumeId}/actions`, {
      type: "attach",
      droplet_id: Number(serverId),
    });
    return mapAction(data.action);
  }

  async detachVolume(volumeId: number | string): Promise<ComputeAction> {
    // Detach needs the droplet id it is currently attached to.
    const current = await this.getVolume(volumeId);
    const dropletId = current?.server;
    if (dropletId === null || dropletId === undefined) {
      throw new DigitalOceanComputeError(
        "invalid_input",
        `Volume ${volumeId} is not attached to any droplet; cannot detach`,
      );
    }
    const data = await this.request<{ action: DOAction }>("POST", `/volumes/${volumeId}/actions`, {
      type: "detach",
      droplet_id: Number(dropletId),
    });
    return mapAction(data.action);
  }

  async deleteVolume(id: number | string): Promise<void> {
    try {
      await this.request<unknown>("DELETE", `/volumes/${id}`);
      logger.info("[do] Deleted volume", { volumeId: id });
    } catch (err) {
      if (err instanceof DigitalOceanComputeError && err.code === "not_found") return;
      throw err;
    }
  }

  // ----------------------------------------------------------------------
  // The load-bearing async primitive
  // ----------------------------------------------------------------------

  /**
   * Poll `GET /actions/:id` until the action leaves `in-progress`. DO actions
   * are terminal at `completed` (mapped to `success`) or `errored` (mapped to
   * `error`); they are NEVER `running`, so — unlike Hetzner — the loop predicate
   * is `while raw === "in-progress"`.
   */
  async waitForAction(actionId: number | string, timeoutMs = 120_000): Promise<ComputeAction> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = await this.request<{ action: DOAction }>("GET", `/actions/${actionId}`);
      if (data.action.status !== "in-progress") return mapAction(data.action);
      await this.sleep(2000);
    }
    throw new DigitalOceanComputeError(
      "transport_error",
      `DigitalOcean action ${actionId} did not complete within ${timeoutMs}ms`,
    );
  }

  // ----------------------------------------------------------------------
  // Catalog (read-only)
  // ----------------------------------------------------------------------

  async listServerTypes(): Promise<ComputeServerType[]> {
    const data = await this.request<{ sizes: DOSize[] }>("GET", `/sizes?per_page=${LIST_PER_PAGE}`);
    return data.sizes.map((s) => ({
      id: s.slug,
      name: s.slug,
      vcpus: s.vcpus,
      // DO reports memory in MiB; surface it as memoryMb for clarity.
      memoryMb: s.memory,
    }));
  }

  async listLocations(): Promise<ComputeLocation[]> {
    const data = await this.request<{ regions: DORegion[] }>(
      "GET",
      `/regions?per_page=${LIST_PER_PAGE}`,
    );
    return data.regions.map((r) => ({ id: r.slug, name: r.name }));
  }

  async listImages(filter?: {
    type?: string;
    architecture?: "x86" | "arm";
  }): Promise<ComputeImage[]> {
    const params: string[] = [`per_page=${LIST_PER_PAGE}`];
    if (filter?.type) params.push(`type=${encodeURIComponent(filter.type)}`);
    const qs = `?${params.join("&")}`;
    const data = await this.request<{ images: DOImage[] }>("GET", `/images${qs}`);
    // DO images have no architecture facet; the `architecture` filter is a
    // Hetzner concept and is accepted-but-ignored for interface parity.
    return data.images.map((img) => ({ id: img.id, name: img.name }));
  }

  // ----------------------------------------------------------------------
  // Internal HTTP
  // ----------------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = this.tokenGetter();
    if (!token) {
      throw new DigitalOceanComputeError(
        "missing_token",
        "DigitalOcean API token is not configured. Set DO_API_TOKEN or DIGITALOCEAN_TOKEN to enable elastic droplet provisioning.",
      );
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (err) {
      throw new DigitalOceanComputeError(
        "transport_error",
        `DigitalOcean API ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
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
      throw new DigitalOceanComputeError(
        "server_error",
        `DigitalOcean API ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`,
        response.status,
      );
    }

    if (!response.ok) {
      // DO error envelope: { id: "...", message: "..." }.
      const errorPayload =
        parsed && typeof parsed === "object"
          ? (parsed as { id?: string; message?: string })
          : undefined;
      const code = mapStatusToCode(response.status, errorPayload?.id);
      throw new DigitalOceanComputeError(
        code,
        errorPayload?.message ??
          `DigitalOcean API ${method} ${path} failed with status ${response.status}`,
        response.status,
      );
    }

    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Mappers (DO wire shape → Compute* normalized shape)
// ---------------------------------------------------------------------------

/** Map DO droplet status → Hetzner-vocabulary `ComputeServer.status`. */
export function mapDropletStatus(status: DropletStatus | string): string {
  switch (status) {
    case "active":
      return "running";
    case "new":
      return "initializing";
    case "off":
      return "off";
    case "archive":
      return "off";
    default:
      return status;
  }
}

/** Map DO action status → Hetzner-vocabulary `ComputeAction.status`. */
export function mapActionStatus(status: DOActionStatus | string): string {
  switch (status) {
    case "completed":
      return "success";
    case "errored":
      return "error";
    case "in-progress":
      return "running";
    default:
      return status;
  }
}

function mapDroplet(d: DODroplet): DOComputeServer {
  const v4 = d.networks?.v4 ?? [];
  const publicIp = v4.find((n) => n.type === "public")?.ip_address;
  const privateIp = v4.find((n) => n.type === "private")?.ip_address;
  const server: DOComputeServer = {
    id: d.id,
    name: d.name,
    status: mapDropletStatus(d.status),
    rawStatus: d.status,
    created: d.created_at,
  };
  if (d.tags && d.tags.length > 0) {
    // Surface tags as labels (value→value) for parity with the labels surface.
    server.labels = Object.fromEntries(d.tags.map((t) => [t, t]));
  }
  if (publicIp !== undefined) server.publicIp = publicIp;
  if (privateIp !== undefined) server.privateIp = privateIp;
  return server;
}

function mapAction(a: DOAction): ComputeAction {
  return {
    id: a.id,
    command: a.type,
    status: mapActionStatus(a.status),
    error: a.status === "errored" ? { code: "errored", message: `action ${a.id} errored` } : null,
  };
}

function mapVolume(v: DOVolume): DOComputeVolume {
  const attached = v.droplet_ids.length > 0 ? v.droplet_ids[0] : null;
  const volume: DOComputeVolume = {
    id: v.id,
    name: v.name,
    size: v.size_gigabytes,
    server: attached ?? null,
    // DO returns volumes already created (no "creating" state on read).
    status: "available",
  };
  if (v.tags && v.tags.length > 0) {
    volume.labels = Object.fromEntries(v.tags.map((t) => [t, t]));
  }
  return volume;
}

/**
 * DO accepts either a numeric image id or a slug for the `image` field. The
 * `CreateServerInput.image` is a string; coerce an all-digits string to a
 * number so DO treats it as an id rather than a slug lookup.
 */
function dropletImage(image: string): number | string {
  return /^\d+$/.test(image) ? Number(image) : image;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapStatusToCode(status: number, apiId?: string): DigitalOceanErrorCode {
  // DO returns 422 with body id `unprocessable_entity` for quota/limit hits
  // (e.g. droplet limit reached). Surface those as quota_exceeded so operators
  // don't chase an auth bug.
  if (apiId === "limit_reached" || apiId === "too_many_requests_droplet_limit") {
    return "quota_exceeded";
  }
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "missing_token";
  if (status === 422 || status === 400) return "invalid_input";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "server_error";
}

// ---------------------------------------------------------------------------
// Module accessors
// ---------------------------------------------------------------------------

let cachedProvider: DigitalOceanComputeProvider | null = null;

/** Singleton accessor using the default env-backed token getter. */
export function getDigitalOceanComputeProvider(): DigitalOceanComputeProvider {
  if (!cachedProvider) cachedProvider = new DigitalOceanComputeProvider();
  return cachedProvider;
}

/** Whether the DO elastic-provisioning surface is configured (token present). */
export function isDigitalOceanComputeConfigured(): boolean {
  return defaultDigitalOceanTokenGetter() !== undefined;
}
