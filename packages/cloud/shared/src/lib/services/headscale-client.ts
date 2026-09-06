/**
 * Headscale VPN Client
 * REST API client for the Headscale coordination server.
 * Ported from eliza-cloud's headscale-manager.ts
 *
 * Provides node management, pre-auth key generation, and route control
 * for container VPN enrollment via the Headscale API.
 */

import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { logger } from "../utils/logger";

const HEADSCALE_API_URL = process.env.HEADSCALE_API_URL || "http://localhost:8081";
const HEADSCALE_API_KEY = process.env.HEADSCALE_API_KEY || "";
const HEADSCALE_USER = process.env.HEADSCALE_USER || "agent";

/** Default timeout for API requests (ms) */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Timeout for health checks (ms) */
const HEALTH_TIMEOUT_MS = 5_000;

/** Typed non-2xx response. Callers may suppress only an exact HTTP status. */
export class HeadscaleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    statusText: string,
  ) {
    super(`Headscale API ${method} ${path} failed: ${status} ${statusText}`);
    this.name = "HeadscaleHttpError";
  }
}

async function readHeadscaleErrorBody(
  resp: Response,
  method: string,
  path: string,
): Promise<string> {
  try {
    return await resp.text();
  } catch (error) {
    // error-policy:J2 context-adding rethrow; an unreadable upstream body is part of the failure.
    throw new Error(
      `Headscale API ${method} ${path} failed: ${resp.status} ${resp.statusText}; error body could not be read`,
      { cause: error },
    );
  }
}

/** Escape a literal string for embedding in a RegExp source (hostnames carry
 *  hyphens today; escaping keeps the suffix matcher safe for any future name). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Default pre-auth key TTL (minutes) when `HEADSCALE_PREAUTH_TTL_MIN` is unset. */
export const DEFAULT_PREAUTH_TTL_MIN = 1440;

/** Exact positive-decimal minutes. Rejects exponent, hex, fraction, and 0-prefix. */
const PREAUTH_TTL_MINUTES_GRAMMAR = /^[1-9]\d*$/;

/**
 * Operational ceiling (30 days). Longer reusable keys baked into Docker env
 * become multi-millennial credentials; larger values also overflow TimeClip
 * in `new Date(Date.now() + ms).toISOString()`.
 */
export const MAX_PREAUTH_TTL_MIN = 43_200;

/** ECMA-262 TimeClip magnitude. */
export const ECMA_TIME_CLIP_MS = 8.64e15;

/**
 * Pre-auth key TTL window (ms): how long a freshly-created key stays valid for a
 * container to boot AND finish VPN enrollment. 10 min proved too tight on slow
 * boots — the key could expire before headscale registration completed, looping
 * the container on re-auth (one prod agent hit 176 restarts before this was
 * raised on the box).
 *
 * Default raised 60m -> 1440m (24h) after the prod-2 hard-reset outage: the key
 * is baked into the container's Docker env at create time and is the ONLY
 * credential a de-authorized node can present after a reboot. A 60-min key is
 * expired the moment such a reboot happens (hours/days/months later), so the
 * container can never rejoin the mesh and crash-loops. A 24h default does not
 * fix an already-baked expired key on its own (the durable fix is the
 * reconnect-first + re-key entrypoint), but it widens the window in which a
 * freshly provisioned agent can survive a delayed first boot or an early
 * reboot. Env-overridable via `HEADSCALE_PREAUTH_TTL_MIN` (exact positive
 * decimal minutes in `[1, MAX_PREAUTH_TTL_MIN]`) so it survives a daemon
 * redeploy and ops can retune without a code change.
 */
export function resolvePreAuthTtlMs(): number {
  const fallback = DEFAULT_PREAUTH_TTL_MIN * 60 * 1000;
  // Literal grammar: do not trim. Padded " 90 " is not an exact positive decimal.
  const raw = process.env.HEADSCALE_PREAUTH_TTL_MIN ?? "";
  if (!PREAUTH_TTL_MINUTES_GRAMMAR.test(raw)) {
    return fallback;
  }
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_PREAUTH_TTL_MIN) {
    return fallback;
  }
  const ms = minutes * 60 * 1000;
  if (!Number.isFinite(ms)) {
    return fallback;
  }
  return ms;
}

function isoExpirationOrThrow(nowMs: number, ttlMs: number): string {
  const expirationMs = nowMs + ttlMs;
  if (!Number.isFinite(expirationMs) || Math.abs(expirationMs) > ECMA_TIME_CLIP_MS) {
    throw new Error("[headscale] pre-auth expiration is outside TimeClip");
  }
  try {
    return new Date(expirationMs).toISOString();
  } catch (error) {
    // error-policy:J2 TimeClip-invalid Date must not reach Headscale.
    throw new Error("[headscale] pre-auth expiration is outside TimeClip", {
      cause: error,
    });
  }
}

/**
 * Build the ISO expiration used by {@link HeadscaleClient.createPreAuthKey}.
 * Tries the env TTL, then the 24h fallback. Throws (fetch must not run) if
 * even the fallback instant is outside TimeClip.
 */
export function resolvePreAuthExpirationIso(nowMs: number = Date.now()): string {
  const envTtl = resolvePreAuthTtlMs();
  const fallback = DEFAULT_PREAUTH_TTL_MIN * 60 * 1000;
  try {
    return isoExpirationOrThrow(nowMs, envTtl);
  } catch (error) {
    if (envTtl === fallback) {
      throw error;
    }
    return isoExpirationOrThrow(nowMs, fallback);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadscaleNode {
  id: string;
  name: string;
  user: { name: string };
  ipAddresses: string[];
  online: boolean;
  lastSeen: string;
  createdAt: string;
}

export interface HeadscalePreAuthKey {
  id: string;
  key: string;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration: string;
}

export interface HeadscaleRoute {
  id: string;
  node: string;
  prefix: string;
  enabled: boolean;
}

export interface HeadscaleUser {
  id: number | string;
  name: string;
}

function nodeByNameOrSuffixed(
  nodes: readonly HeadscaleNode[],
  name: string,
  options?: { excludeNodeId?: string; createdAfter?: Date },
): HeadscaleNode | null {
  const exact = nodes.find((node) => node.name === name && node.id !== options?.excludeNodeId);
  if (exact) return exact;

  // Anchored on Headscale's exact collision-rename shape. The creation gate
  // prevents cleanup or routing from adopting an older sibling or orphan.
  const suffixPattern = new RegExp(`^${escapeRegExp(name)}-[a-z0-9]{8}$`);
  const createdAfterMs = options?.createdAfter?.getTime();
  const candidates = nodes.filter(
    (node) =>
      node.id !== options?.excludeNodeId &&
      suffixPattern.test(node.name) &&
      (createdAfterMs === undefined || Date.parse(node.createdAt) >= createdAfterMs),
  );
  if (candidates.length === 0) return null;
  candidates.sort(compareHeadscaleIds);
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function compareHeadscaleIds(a: { id: string }, b: { id: string }): number {
  const bNum = Number((b as any).id);
  const aNum = Number((a as any).id);
  const bVal = Number.isFinite(bNum) ? bNum : 0;
  const aVal = Number.isFinite(aNum) ? aNum : 0;
  return bVal - aVal || String(b.id).localeCompare(String(a.id));
}

/** Public service identity; API credentials stay in configuration and may rotate independently. */
export interface HeadscaleServerAuthority {
  apiUrl: string;
  enrollmentUser: string;
  publicKey: string;
}

const serverPublicKeySchema = z.object({
  publicKey: z
    .string()
    .regex(/^mkey:[0-9a-f]{64}$/)
    .refine((value) => value !== `mkey:${"0".repeat(64)}`),
});

const nodeIdSchema = z
  .string()
  .refine(
    (value) =>
      /^[1-9][0-9]*$/.test(value) &&
      (value.length < 20 || (value.length === 20 && value <= "18446744073709551615")),
  );
const nodeIdentitySchema = z.object({
  id: nodeIdSchema,
  machineKey: serverPublicKeySchema.shape.publicKey,
  createdAt: z.iso.datetime({ offset: true }),
});
const nodeAuthoritySchema = z.object({
  server: z.object({
    apiUrl: z.string(),
    enrollmentUser: z.string(),
    publicKey: serverPublicKeySchema.shape.publicKey,
  }),
  node: nodeIdentitySchema,
});

/** Stable registration identity excludes node keys that can rotate during normal operation. */
export type HeadscaleNodeAuthority = z.infer<typeof nodeAuthoritySchema>;
export interface HeadscaleNodeAbsenceReceipt {
  state: "absent";
  authority: HeadscaleNodeAuthority;
  observedAt: string;
}

const enrollmentAuthoritySchema = nodeAuthoritySchema.extend({
  node: nodeIdentitySchema.nullable(),
});
export type HeadscaleEnrollmentAuthority = z.infer<typeof enrollmentAuthoritySchema>;

/** Decode durable enrollment scope without supplying missing identity from current configuration. */
export function parseHeadscaleEnrollmentAuthority(
  value: unknown,
  expectedNodeId?: string | null,
): HeadscaleEnrollmentAuthority {
  const parsed = enrollmentAuthoritySchema.safeParse(value);
  if (!parsed.success)
    throw new ElizaError("Headscale enrollment authority is invalid", {
      code: "HEADSCALE_ENROLLMENT_AUTHORITY_INVALID",
    });
  if (
    expectedNodeId !== undefined &&
    parsed.data.node !== null &&
    parsed.data.node.id !== expectedNodeId
  )
    throw new ElizaError("Headscale enrollment authority disagrees with the placement node", {
      code: "HEADSCALE_ENROLLMENT_NODE_MISMATCH",
    });
  return parsed.data;
}

/** Registration may enrich a recorded server scope once; retries cannot replace that scope or node. */
export function mergeHeadscaleEnrollmentAuthority(
  existing: HeadscaleEnrollmentAuthority | null,
  incoming: HeadscaleEnrollmentAuthority | null,
): HeadscaleEnrollmentAuthority | null {
  if (existing === null && incoming === null) return null;
  if (
    !existing ||
    !incoming ||
    existing.server.apiUrl !== incoming.server.apiUrl ||
    existing.server.enrollmentUser !== incoming.server.enrollmentUser ||
    existing.server.publicKey !== incoming.server.publicKey ||
    (existing.node !== null &&
      incoming.node !== null &&
      (existing.node.id !== incoming.node.id ||
        existing.node.machineKey !== incoming.node.machineKey ||
        existing.node.createdAt !== incoming.node.createdAt))
  ) {
    throw new ElizaError("Headscale enrollment authority changed after intent admission", {
      code: "HEADSCALE_ENROLLMENT_AUTHORITY_CHANGED",
    });
  }
  return existing.node ? existing : incoming;
}

/** Validate every inventory ID before selecting one registration or proving its absence. */
function findNodeInAuthoritativeInventory(
  nodes: HeadscaleNode[],
  nodeId: string,
): HeadscaleNode | null {
  const ids = new Set<string>();
  let found: HeadscaleNode | null = null;
  for (const node of nodes) {
    const parsed = z.object({ id: nodeIdSchema }).safeParse(node);
    if (!parsed.success || ids.has(parsed.data.id))
      throw new ElizaError("Headscale inventory contains invalid or duplicate node identities", {
        code: "HEADSCALE_NODE_INVENTORY_INVALID",
      });
    ids.add(parsed.data.id);
    if (parsed.data.id === nodeId) found = node;
  }
  return found;
}

export class HeadscaleClient {
  private baseUrl: string;
  private apiKey: string;
  private user: string;

  constructor(opts?: { apiUrl?: string; apiKey?: string; user?: string }) {
    this.baseUrl = opts?.apiUrl || HEADSCALE_API_URL;
    this.apiKey = opts?.apiKey || HEADSCALE_API_KEY;
    this.user = opts?.user || HEADSCALE_USER;
  }

  private configuredAuthorityScope(): Pick<HeadscaleServerAuthority, "apiUrl" | "enrollmentUser"> {
    const url = new URL(this.baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !this.user.trim()
    ) {
      throw new ElizaError("Headscale authority configuration is invalid", {
        code: "HEADSCALE_AUTHORITY_CONFIG_INVALID",
      });
    }
    return { apiUrl: url.href.replace(/\/+$/, ""), enrollmentUser: this.user };
  }

  /** Observe the Noise key through the configured endpoint without transmitting an API credential. */
  async captureServerAuthority(): Promise<HeadscaleServerAuthority> {
    const scope = this.configuredAuthorityScope();
    const response = await fetch(`${scope.apiUrl}/key?v=39`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new HeadscaleHttpError(response.status, "GET", "/key?v=39", response.statusText);
    const parsed = serverPublicKeySchema.safeParse(await response.json());
    if (!parsed.success)
      throw new ElizaError("Headscale server identity response is invalid", {
        code: "HEADSCALE_SERVER_IDENTITY_INVALID",
      });
    return { ...scope, publicKey: parsed.data.publicKey };
  }

  /** A stored authority can constrain the configured service, never select a credential destination. */
  async requireServerAuthority(expected: HeadscaleServerAuthority): Promise<void> {
    const expectedKey = expected.publicKey;
    const scope = this.configuredAuthorityScope();
    if (scope.apiUrl !== expected.apiUrl || scope.enrollmentUser !== expected.enrollmentUser) {
      throw new ElizaError("Headscale cleanup scope differs from captured authority", {
        code: "HEADSCALE_SERVER_AUTHORITY_MISMATCH",
      });
    }
    const observed = await this.captureServerAuthority();
    if (observed.publicKey !== expectedKey) {
      throw new ElizaError("Headscale server key differs from captured authority", {
        code: "HEADSCALE_SERVER_AUTHORITY_MISMATCH",
      });
    }
  }

  /** Reject inventory observations made across a detected server identity change. */
  async listNodesForAuthority(expected: HeadscaleServerAuthority): Promise<HeadscaleNode[]> {
    const authority = { ...expected };
    await this.requireServerAuthority(authority);
    const nodes = await this.listNodesStrict();
    await this.requireServerAuthority(authority);
    return nodes;
  }

  /** Capture a discovered registration only under the server identity that admitted enrollment. */
  async captureNodeAuthority(
    server: HeadscaleServerAuthority,
    nodeId: string,
  ): Promise<HeadscaleNodeAuthority> {
    if (!nodeIdSchema.safeParse(nodeId).success)
      throw new ElizaError("Headscale registration ID is invalid", {
        code: "HEADSCALE_NODE_ID_INVALID",
      });
    const expectedServer = { ...server };
    const node = findNodeInAuthoritativeInventory(
      await this.listNodesForAuthority(expectedServer),
      nodeId,
    );
    const parsed = nodeIdentitySchema.safeParse(node);
    if (!parsed.success)
      throw new ElizaError("Headscale registration identity is unavailable", {
        code: "HEADSCALE_NODE_IDENTITY_UNAVAILABLE",
      });
    return { server: expectedServer, node: parsed.data };
  }

  /** Remove only the captured registration and settle uncertain responses through scoped inventory. */
  async deleteNodeForAuthority(
    expected: HeadscaleNodeAuthority,
  ): Promise<HeadscaleNodeAbsenceReceipt> {
    const parsed = nodeAuthoritySchema.safeParse(expected);
    if (!parsed.success)
      throw new ElizaError("Headscale deletion authority is malformed", {
        code: "HEADSCALE_NODE_AUTHORITY_INVALID",
      });
    const authority = parsed.data;
    const before = findNodeInAuthoritativeInventory(
      await this.listNodesForAuthority(authority.server),
      authority.node.id,
    );
    if (before) {
      const identity = nodeIdentitySchema.safeParse(before);
      if (
        !identity.success ||
        identity.data.machineKey !== authority.node.machineKey ||
        identity.data.createdAt !== authority.node.createdAt
      )
        throw new ElizaError("Headscale node differs from captured registration", {
          code: "HEADSCALE_NODE_AUTHORITY_MISMATCH",
        });
      let deletionFailure: unknown;
      try {
        await this.deleteNode(authority.node.id);
      } catch (error) {
        // error-policy:J1 The scoped readback below settles uncertain deletion; presence remains an error.
        deletionFailure = error;
      }
      const remaining = findNodeInAuthoritativeInventory(
        await this.listNodesForAuthority(authority.server),
        authority.node.id,
      );
      if (remaining)
        throw new ElizaError("Headscale node retirement remains unresolved", {
          code: "HEADSCALE_NODE_RETIREMENT_UNPROVEN",
          cause: deletionFailure,
        });
    }
    return { state: "absent", authority, observedAt: new Date().toISOString() };
  }

  // -------------------------------------------------------------------------
  // Server status
  // -------------------------------------------------------------------------

  /**
   * Check whether the Headscale server is reachable and return high-level stats.
   */
  async getStatus(): Promise<{ online: boolean; nodeCount: number }> {
    try {
      const healthResp = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });

      if (!healthResp.ok) {
        logger.warn("[headscale] health check returned non-OK status");
        return { online: false, nodeCount: 0 };
      }

      const nodes = await this.listNodes();
      return { online: true, nodeCount: nodes.length };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("[headscale] status check failed:", msg);
      return { online: false, nodeCount: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Node management
  // -------------------------------------------------------------------------

  /** List all registered nodes. */
  async listNodes(): Promise<HeadscaleNode[]> {
    try {
      return await this.listNodesStrict();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("[headscale] error listing nodes:", msg);
      return [];
    }
  }

  /** List nodes while propagating API failures to callers that must fail closed. */
  async listNodesStrict(): Promise<HeadscaleNode[]> {
    const data = await this.request<{ nodes?: HeadscaleNode[] }>("GET", "/api/v1/node");
    if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.nodes)) {
      throw new ElizaError("Headscale node inventory response is malformed", {
        code: "HEADSCALE_NODE_INVENTORY_INVALID",
      });
    }
    return data.nodes;
  }

  /** Find a node by its hostname. */
  async getNodeByName(name: string): Promise<HeadscaleNode | null> {
    const nodes = await this.listNodes();
    return nodes.find((n) => n.name === name) ?? null;
  }

  /**
   * Find a node by hostname, tolerating Headscale's collision rename.
   * When a node registers under a hostname that is already taken (the exact
   * blue/green upgrade overlap: the preserved live node holds the base name),
   * Headscale assigns `<name>-<8 random lowercase alphanumerics>` as the
   * givenName (GenerateRandomStringDNSSafe(8), e.g. the observed
   * `eliza-00e6292c-e55-cnpx9uop`). An exact-match poll then never sees the
   * new node and the upgrade times out even though the blue container
   * registered fine.
   *
   * The exact name wins unconditionally. A suffixed candidate is accepted only
   * when it matches the rename shape exactly AND — when `createdAfter` is set —
   * was created at/after that instant. Renamed nodes keep their suffix forever
   * (there is no rename-back guarantee), so without the createdAt gate a poll
   * would happily adopt the previous cycle's live green node or an orphan from
   * an earlier failed upgrade and route the sandbox to the wrong container.
   * `excludeNodeId` drops the known preserved green node from both paths.
   */
  async getNodeByNameOrSuffixed(
    name: string,
    options?: { excludeNodeId?: string; createdAfter?: Date },
  ): Promise<HeadscaleNode | null> {
    const nodes = await this.listNodes();
    return nodeByNameOrSuffixed(nodes, name, options);
  }

  /**
   * Strict collision-aware lookup for security-sensitive cleanup. Unlike the
   * best-effort discovery helper, this propagates a failed Headscale listing
   * and therefore never clears durable compensation state on uncertainty.
   */
  async getNodeByNameOrSuffixedStrict(
    name: string,
    options?: { excludeNodeId?: string; createdAfter?: Date },
  ): Promise<HeadscaleNode | null> {
    const nodes = await this.listNodesStrict();
    return nodeByNameOrSuffixed(nodes, name, options);
  }

  /** Rename a node's givenName (POST /api/v1/node/{nodeId}/rename/{newName}). */
  async renameNode(nodeId: string, newName: string): Promise<void> {
    await this.request<Record<string, unknown>>(
      "POST",
      `/api/v1/node/${nodeId}/rename/${encodeURIComponent(newName)}`,
    );
    logger.info(`[headscale] renamed node ${nodeId} to ${newName}`);
  }

  /** Find a node by hostname while propagating listing failures. */
  async getNodeByNameStrict(name: string): Promise<HeadscaleNode | null> {
    const nodes = await this.listNodesStrict();
    return nodes.find((n) => n.name === name) ?? null;
  }

  /** Get the first IP address for a node identified by hostname. */
  async getNodeIP(name: string): Promise<string | null> {
    const node = await this.getNodeByName(name);
    if (!node || node.ipAddresses.length === 0) return null;
    return node.ipAddresses[0];
  }

  /** Delete a node from the Headscale network. */
  async deleteNode(nodeId: string): Promise<void> {
    try {
      logger.info(`[headscale] deleting node ${nodeId}`);
      await this.request<Record<string, unknown>>("DELETE", `/api/v1/node/${nodeId}`);
      logger.info(`[headscale] deleted node ${nodeId}`);
    } catch (error: unknown) {
      // 404 is acceptable – node already gone
      if (error instanceof HeadscaleHttpError && error.status === 404) {
        logger.warn(`[headscale] node ${nodeId} already deleted (404)`);
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[headscale] error deleting node ${nodeId}:`, msg);
      throw error;
    }
  }

  /** Set ACL tags on a node (PUT /api/v1/node/{nodeId}/tags). */
  async setNodeTags(nodeId: string, tags: string[]): Promise<void> {
    try {
      await this.request<Record<string, unknown>>("POST", `/api/v1/node/${nodeId}/tags`, { tags });
      logger.info(`[headscale] set tags on node ${nodeId}: ${tags.join(", ")}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[headscale] error setting tags on node ${nodeId}:`, msg);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Pre-auth keys
  // -------------------------------------------------------------------------

  /**
   * Create a pre-auth key that containers use to join the VPN on boot.
   *
   * @param opts.reusable   Allow the key to be used more than once (default false)
   * @param opts.ephemeral  Node will be removed once it goes offline (default false)
   * @param opts.expiration ISO-8601 expiration timestamp (default: now + HEADSCALE_PREAUTH_TTL_MIN, 24h)
   * @param opts.aclTags    ACL tags to attach to the key (default: ["tag:agent"])
   * @param opts.user       Personal-node owner. Headscale v0.28 tagged keys
   *                        deliberately omit this field because tags and user
   *                        ownership are mutually exclusive identities.
   */
  async createPreAuthKey(opts?: {
    reusable?: boolean;
    ephemeral?: boolean;
    expiration?: string;
    aclTags?: string[];
    user?: string;
    ensureUser?: boolean;
  }): Promise<HeadscalePreAuthKey> {
    const {
      reusable = false,
      ephemeral = false,
      expiration,
      aclTags = ["tag:agent"],
      user,
      ensureUser = false,
    } = opts ?? {};

    if (aclTags.length > 0 && (user !== undefined || ensureUser)) {
      throw new Error("[headscale] tagged pre-auth keys cannot also carry user ownership on v0.28");
    }

    // The key must stay valid long enough for the container to boot AND finish
    // VPN enrollment; 10 min was too tight on slow boots (key expired mid-
    // registration -> container re-auth loop). Default 24h, env-overridable
    // via HEADSCALE_PREAUTH_TTL_MIN (see resolvePreAuthTtlMs).
    const expirationTime = expiration ?? resolvePreAuthExpirationIso();

    const userId =
      aclTags.length === 0
        ? ensureUser
          ? await this.ensureUser(user)
          : await this.resolveUserId(user)
        : undefined;

    const data = await this.request<{
      preAuthKey?: HeadscalePreAuthKey;
    }>("POST", "/api/v1/preauthkey", {
      ...(userId === undefined ? {} : { user: userId }),
      reusable,
      ephemeral,
      expiration: expirationTime,
      aclTags,
    });

    const key = data.preAuthKey;
    if (!key?.key) {
      throw new Error("[headscale] No pre-auth key returned from API");
    }

    logger.info("[headscale] created pre-auth key");
    return key;
  }

  /** List all pre-auth keys for the configured user. */
  async listPreAuthKeys(): Promise<HeadscalePreAuthKey[]> {
    try {
      const data = await this.request<{
        preAuthKeys?: HeadscalePreAuthKey[];
      }>("GET", "/api/v1/preauthkey");
      return data.preAuthKeys ?? [];
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("[headscale] error listing pre-auth keys:", msg);
      return [];
    }
  }

  /**
   * Expire a v0.28 pre-auth key by numeric id. The v0.28 REST contract uses a
   * JSON body at POST /api/v1/preauthkey/expire (not a key in the URL).
   */
  async expirePreAuthKey(id: string): Promise<void> {
    if (!/^[1-9]\d*$/.test(id)) {
      throw new Error("[headscale] invalid pre-auth key id");
    }
    try {
      await this.request<Record<string, unknown>>("POST", "/api/v1/preauthkey/expire", { id });
    } catch (error) {
      if (error instanceof HeadscaleHttpError && error.status === 404) return;
      throw error;
    }
  }

  /**
   * Delete a v0.28 pre-auth key by numeric id. grpc-gateway exposes the id as a
   * query parameter on DELETE /api/v1/preauthkey.
   */
  async deletePreAuthKey(id: string): Promise<void> {
    if (!/^[1-9]\d*$/.test(id)) {
      throw new Error("[headscale] invalid pre-auth key id");
    }
    try {
      await this.request<Record<string, unknown>>(
        "DELETE",
        `/api/v1/preauthkey?id=${encodeURIComponent(id)}`,
      );
    } catch (error) {
      if (error instanceof HeadscaleHttpError && error.status === 404) return;
      throw error;
    }
  }

  async ensureUser(user = this.user): Promise<number> {
    const existing = await this.findUser(user);
    if (existing) return existing;

    try {
      await this.request<Record<string, unknown>>("POST", "/api/v1/user", { name: user });
    } catch (error) {
      const afterRace = await this.findUser(user);
      if (afterRace) return afterRace;
      throw error;
    }

    const created = await this.findUser(user);
    if (created) return created;
    throw new Error(`[headscale] user not found after create: ${user}`);
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /** List all advertised routes across nodes. */
  async listRoutes(): Promise<HeadscaleRoute[]> {
    try {
      const data = await this.request<{ routes?: HeadscaleRoute[] }>("GET", "/api/v1/routes");
      return data.routes ?? [];
    } catch (error: unknown) {
      // Some older Headscale versions may not support /routes
      if (error instanceof HeadscaleHttpError && error.status === 404) {
        logger.warn("[headscale] routes endpoint not supported; returning empty list");
        return [];
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("[headscale] error listing routes:", msg);
      return [];
    }
  }

  /** Enable an advertised route by its ID. */
  async enableRoute(routeId: string): Promise<void> {
    try {
      await this.request<Record<string, unknown>>("POST", `/api/v1/routes/${routeId}/enable`);
      logger.info(`[headscale] enabled route ${routeId}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[headscale] error enabling route ${routeId}:`, msg);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Generic HTTP request helper for the Headscale REST API.
   * All requests include the Bearer token and an abort timeout.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    const init: RequestInit = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const resp = await fetch(url, init);

    if (!resp.ok) {
      const text = await readHeadscaleErrorBody(resp, method, path);
      // Log raw body at debug level only — don't leak it into error messages
      logger.debug(`[headscale] API error body for ${method} ${path}:`, {
        body: text,
      });
      throw new HeadscaleHttpError(resp.status, method, path, resp.statusText);
    }

    // Some endpoints (DELETE) may not return a body
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await resp.json()) as T;
    }

    return {} as T;
  }

  /**
   * Resolve the configured HEADSCALE_USER to a numeric user ID.
   * Falls back to listing users via the API if the value isn't already numeric.
   */
  private async resolveUserId(user = this.user): Promise<number> {
    // If user looks numeric, use directly
    if (/^\d+$/.test(user)) {
      return Number(user);
    }

    const match = await this.findUser(user);
    if (!match) {
      throw new Error(`[headscale] user not found or invalid: ${user}`);
    }

    return match;
  }

  private async listUsers(): Promise<HeadscaleUser[]> {
    const data = await this.request<{
      users?: HeadscaleUser[];
    }>("GET", "/api/v1/user");
    return data.users ?? [];
  }

  private async findUser(user: string): Promise<number | null> {
    if (/^\d+$/.test(user)) return Number(user);
    const users = await this.listUsers();
    const match = users.find((u) => u.name === user || String(u.id) === user);
    if (!match?.id || !/^\d+$/.test(String(match.id))) return null;
    return Number(match.id);
  }
}

/** Default singleton instance using environment variables. */
export const headscaleClient = new HeadscaleClient();
