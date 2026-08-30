/**
 * Headscale VPN Integration
 *
 * Higher-level service that ties Headscale VPN to the Docker container
 * lifecycle. Handles pre-auth key generation, VPN registration polling,
 * and cleanup when containers are removed.
 *
 * Flow:
 *  1. prepareContainerVPN(input) — generates a pre-auth key + env vars
 *  2. Container boots, runs `tailscale up --authkey=... --hostname=...`
 *  3. waitForVPNRegistration(agentId) — polls headscale until the node appears
 *  4. cleanupContainerVPN(nodeName) — removes the VPN node when the container dies
 */

import { ElizaError } from "@elizaos/core";
import { logger } from "../utils/logger";
import { HeadscaleClient, type HeadscaleNode, headscaleClient } from "./headscale-client";

/** Initial polling interval when waiting for VPN registration (ms). */
const POLL_INTERVAL_INITIAL_MS = 1_000;

/** Maximum polling interval after exponential backoff (ms). */
const POLL_INTERVAL_MAX_MS = 8_000;

/**
 * Default timeout for VPN/headscale registration (ms), env-overridable via
 * `VPN_REGISTRATION_TIMEOUT_MS`.
 *
 * 180s, not 60s: a cold container can take well over a minute to boot and run
 * `tailscale up`, so the old hardcoded 60s expired BEFORE the node finished
 * registering. The caller then logged "continuing without VPN" and the agent
 * answered 404 over the router despite the container being up. 180s clears a
 * cold registration with margin; this is the value 0xSolace set on the live box
 * while working the outage, and the env override lets ops retune without a
 * redeploy. Exported so the docker-sandbox provider shares this single source
 * of truth instead of hardcoding its own timeout at the call site.
 */
export const DEFAULT_REGISTRATION_TIMEOUT_MS = (() => {
  const raw = process.env.VPN_REGISTRATION_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
})();

function headscalePublicUrl(): string {
  return (
    process.env.HEADSCALE_PUBLIC_URL || process.env.HEADSCALE_API_URL || "http://localhost:8081"
  );
}

export interface PrepareContainerVPNInput {
  agentId: string;
  agentName?: string;
  organizationId?: string;
  userId?: string;
  /**
   * When false, an existing node under the deterministic hostname is RECORDED
   * (returned as `previousNodeId`) instead of deleted (#16565). Blue/green
   * upgrade/downgrade set this: the "stale" registration is the LIVE serving
   * node until the atomic swap commits, and deleting it pre-provision cuts
   * the agent's mesh route mid-upgrade (its single-use auth key then leaves
   * the evicted container in a permanent restart loop). Default true — the
   * plain reprovision path keeps today's reclaim behavior, which guards
   * `waitForVPNRegistration` from accepting the stale node's IP.
   */
  reclaimStaleNode?: boolean;
  /**
   * Require a post-delete strict inventory proving both the deleted node id
   * and the deterministic hostname are absent before a replacement key is
   * minted. Exact-success provisioning enables this because an ambiguous
   * Headscale DELETE must retain its fence across concurrent renames.
   */
  requireExactNodeRetirement?: boolean;
}

export type HeadscaleRegistrationRenameCompletion =
  | { readonly outcome: "not-needed" }
  | { readonly outcome: "succeeded" }
  | { readonly outcome: "conflict-proven"; readonly cause: unknown }
  | { readonly outcome: "unresolved"; readonly cause: unknown };

export interface HeadscaleVpnRegistration {
  readonly ip: string;
  readonly nodeId: string;
  /** Exact observation of the optional collision-name reconciliation. */
  readonly rename: HeadscaleRegistrationRenameCompletion;
}

const MAX_HEADSCALE_NODE_ID = "18446744073709551615";

/** Headscale route parameters are positive canonical uint64 decimal strings. */
export function isCanonicalHeadscaleNodeId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
  return (
    value.length < MAX_HEADSCALE_NODE_ID.length ||
    (value.length === MAX_HEADSCALE_NODE_ID.length && value <= MAX_HEADSCALE_NODE_ID)
  );
}

/** The Docker provider builds an HTTP URL from Headscale's first address. */
export function isCanonicalHeadscaleIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number.parseInt(octet, 10) <= 255)
  );
}

/** This deployment's Headscale IPv4 pool is Tailscale CGNAT 100.64.0.0/10. */
export function isCanonicalHeadscaleTailnetIpv4(value: unknown): value is string {
  if (!isCanonicalHeadscaleIpv4(value)) return false;
  const [firstOctet, secondOctet] = value.split(".").map((octet) => Number.parseInt(octet, 10));
  return firstOctet === 100 && secondOctet !== undefined && secondOctet >= 64 && secondOctet <= 127;
}

/** Reject untrusted Headscale response identities before route mutation. */
export function assertCanonicalHeadscaleNode(node: HeadscaleNode): void {
  if (!isCanonicalHeadscaleNodeId(node.id)) {
    throw new ElizaError(
      `[headscale-integration] invalid Headscale node id: ${JSON.stringify(node.id)}`,
      {
        code: "HEADSCALE_NODE_ID_INVALID",
        context: { nodeId: typeof node.id === "string" ? node.id : null },
        severity: "fatal",
      },
    );
  }
}

function isProvenHeadscaleRenameConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Headscale API POST \S+ failed: 409(?:\s|$)/.test(message);
}

export class HeadscaleIntegration {
  private client: HeadscaleClient;

  constructor(client?: HeadscaleClient) {
    this.client = client ?? headscaleClient;
  }

  // -------------------------------------------------------------------------
  // Container lifecycle hooks
  // -------------------------------------------------------------------------

  /**
   * Prepare VPN credentials for a new agent container.
   *
   * Returns a REUSABLE, persistent-node pre-auth key and the full set of
   * environment variables the container needs to join the VPN on boot.
   *
   * The node must not be ephemeral. Docker's `unless-stopped` policy restarts
   * an agent in the same writable layer, so tailscaled reconnects with its
   * persisted node identity. Headscale deletes ephemeral nodes as soon as they
   * disconnect; the restarted container then sees `node no longer exists`,
   * while a single-use auth key can only return `authkey already used`,
   * leaving the agent in a permanent restart loop. Explicit sandbox teardown
   * already calls cleanupContainerVPN(), so persistent nodes are still removed.
   *
   * The key is a v0.28 tag identity, not a user identity: `tag:agent` is
   * attached directly to the pre-auth key and the request intentionally omits
   * `user`. Headscale rejects a tagged key that is also user-bound during
   * registration, which previously left fresh containers asking for
   * interactive auth even though key creation had succeeded.
   *
   * The key is REUSABLE (was single-use) so a reboot that de-authorizes the
   * persisted node identity can re-`up` with the SAME baked key instead of
   * hitting `authkey already used` and crash-looping (the prod-2 hard-reset
   * failure class). Combined with the raised default TTL (24h) and the
   * reconnect-first entrypoint, this makes the boot path resilient: a node
   * reconnects on persisted state when it can, and re-authenticates with a
   * still-valid reusable key when it must. The key stays tag-scoped
   * (`tag:agent`) and ACL-isolated, so reusability is bounded to same-node
   * re-registration of the one agent it was minted for.
   */
  async prepareContainerVPN(input: PrepareContainerVPNInput): Promise<{
    preAuthKey: string;
    envVars: Record<string, string>;
    /** The pre-existing node's id when `reclaimStaleNode` is false (#16565):
     *  the caller excludes it from registration matching and deletes it BY ID
     *  only after its replacement has taken over. */
    previousNodeId?: string;
  }> {
    const { agentId } = input;
    logger.info(`[headscale-integration] preparing VPN for agent ${agentId}`);

    try {
      const tsHostname = inferTailscaleHostname(input);

      // Persistent nodes survive ordinary Docker restarts by design. A full
      // reprovision, however, creates a fresh container and auth key. Remove a
      // stale registration for the deterministic hostname before issuing that
      // key, otherwise waitForVPNRegistration() could accept the old node's IP
      // before the replacement has joined. Fail closed on lookup/deletion
      // errors so we never route a new sandbox to a stale container.
      // Blue/green callers pass reclaimStaleNode=false: the same-name node is
      // the LIVE one, so it is recorded for post-cutover deletion instead.
      let previousNodeId: string | undefined;
      const existingNode = await this.client.getNodeByNameStrict(tsHostname);
      if (existingNode) {
        assertCanonicalHeadscaleNode(existingNode);
        if (input.reclaimStaleNode === false) {
          previousNodeId = existingNode.id;
          logger.info(
            `[headscale-integration] preserving live VPN node ${existingNode.id} during blue/green provision for ${agentId}`,
          );
        } else {
          await this.client.deleteNode(existingNode.id);
          if (input.requireExactNodeRetirement) {
            const remainingNodes = await this.client.listNodesStrict();
            for (const node of remainingNodes) assertCanonicalHeadscaleNode(node);
            if (
              remainingNodes.some((node) => node.id === existingNode.id || node.name === tsHostname)
            ) {
              throw new ElizaError(
                `[headscale-integration] cannot prove stale Headscale node ${existingNode.id} retired before exact reprovision`,
                {
                  code: "HEADSCALE_EXACT_NODE_RETIREMENT_UNPROVEN",
                  context: { nodeId: existingNode.id, nodeName: tsHostname },
                  severity: "fatal",
                },
              );
            }
          }
          logger.info(
            `[headscale-integration] removed stale VPN node ${existingNode.id} before reprovisioning ${agentId}`,
          );
        }
      }

      const preAuthKeyObj = await this.client.createPreAuthKey({
        // Reusable so a reboot that de-authorizes the persisted node identity
        // can re-register with the same baked key rather than crash-looping on
        // `authkey already used`. Bounded by tag:agent + ACL isolation to
        // same-node re-registration of this one agent (see method doc).
        reusable: true,
        ephemeral: false,
        aclTags: ["tag:agent"],
      });

      const envVars: Record<string, string> = {
        HEADSCALE_URL: headscalePublicUrl(),
        TS_AUTHKEY: preAuthKeyObj.key,
        TS_HOSTNAME: tsHostname,
        TS_STATE_DIR: "/var/lib/tailscale",
        TS_EXTRA_ARGS: "--accept-routes",
      };

      logger.info(`[headscale-integration] VPN prepared for agent ${agentId}`);

      return {
        preAuthKey: preAuthKeyObj.key,
        envVars,
        ...(previousNodeId ? { previousNodeId } : {}),
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[headscale-integration] failed to prepare VPN for ${agentId}:`, msg);
      throw error;
    }
  }

  /**
   * Wait for a container to register on the VPN and return its IP.
   *
   * Polls `headscaleClient.getNodeByName(agentId)` every {@link POLL_INTERVAL_MS}
   * until the node appears and has at least one IP address, or the timeout
   * expires.
   *
   * @param nodeName  Headscale node name the container registers under
   *                  (TS_HOSTNAME = inferTailscaleHostname; NOT the bare agentId).
   * @param timeoutMs Maximum time to wait (default {@link DEFAULT_REGISTRATION_TIMEOUT_MS}, 180 s; env-overridable via `VPN_REGISTRATION_TIMEOUT_MS`).
   * @returns The first VPN IP and exact node id together with explicit rename
   *          completion evidence, or `null` if registration was not observed.
   */
  async waitForVPNRegistration(
    nodeName: string,
    timeoutMs: number = DEFAULT_REGISTRATION_TIMEOUT_MS,
    options?: {
      /** Ignore this node id when matching by name (#16565): during a
       *  blue/green overlap the preserved LIVE node shares the hostname, and
       *  accepting its IP would route the new sandbox to the old container —
       *  the exact race the reclaim-mode deletion used to guard against. */
      excludeNodeId?: string;
      /**
       * Inspect the exact Docker candidate after a Headscale miss. Returning
       * an error proves that candidate cannot register and aborts immediately;
       * `null` means it is still pending. The probe is awaited inline, so no
       * detached poll can outlive a successful registration or its cleanup.
       */
      probeTerminalCandidateFailure?: () => Promise<Error | null>;
    },
  ): Promise<HeadscaleVpnRegistration | null> {
    logger.info(
      `[headscale-integration] waiting for VPN registration: ${nodeName} (timeout ${timeoutMs}ms)`,
    );

    // Suffixed (collision-renamed) matches are gated to nodes created during
    // THIS poll: renamed nodes keep their suffix forever, so without the gate a
    // poll would adopt the previous cycle's live green node or a stale orphan
    // from an earlier failed upgrade. Exact-name matches are not gated.
    const pollStart = new Date();
    const deadline = Date.now() + timeoutMs;
    let interval = POLL_INTERVAL_INITIAL_MS;

    while (Date.now() < deadline) {
      try {
        // Collision-rename tolerant lookup: when the preserved green node holds
        // the base hostname, Headscale registers blue as `<name>-<random8>`.
        // Exact-name polling never finds it and the upgrade times out despite a
        // healthy registration.
        const node = await this.client.getNodeByNameOrSuffixed(nodeName, {
          excludeNodeId: options?.excludeNodeId,
          createdAfter: pollStart,
        });

        if (node) assertCanonicalHeadscaleNode(node);
        const nodeId = typeof node?.id === "string" ? node.id : "";
        const firstIp = Array.isArray(node?.ipAddresses) ? node.ipAddresses[0] : undefined;
        const ip = typeof firstIp === "string" ? firstIp : "";
        if (
          node &&
          nodeId &&
          isCanonicalHeadscaleTailnetIpv4(ip) &&
          nodeId !== options?.excludeNodeId
        ) {
          let rename: HeadscaleRegistrationRenameCompletion = { outcome: "not-needed" };
          if (node.name !== nodeName) {
            // The adopted node otherwise keeps its collision suffix forever,
            // and the base hostname is how later lifecycle steps find this
            // node (getNodeByNameStrict on the next provision,
            // cleanupContainerVPN on teardown). While the preserved green node
            // still holds the base name Headscale rejects the rename — the
            // suffixed name then simply persists and the createdAt gate above
            // keeps future polls correct.
            try {
              await this.client.renameNode(nodeId, nodeName);
              rename = { outcome: "succeeded" };
            } catch (error: unknown) {
              // error-policy:J2 translate the rename into explicit completion
              // evidence. Only a returned HTTP 409 proves the expected live-name
              // conflict; timeouts, transport failures, 5xx, and unknown errors
              // remain unresolved because the rename may have committed.
              const msg = error instanceof Error ? error.message : String(error);
              rename = isProvenHeadscaleRenameConflict(error)
                ? { outcome: "conflict-proven", cause: error }
                : { outcome: "unresolved", cause: error };
              logger.warn(
                `[headscale-integration] could not rename node ${nodeId} back to ${nodeName}: ${msg}`,
              );
            }
          }
          logger.info(
            `[headscale-integration] VPN registered for ${nodeName}: ${ip} (node name ${node.name})`,
          );
          return { ip, nodeId, rename };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Distinguish auth errors (401/403) from transient failures
        if (msg.includes("401") || msg.includes("403")) {
          logger.error(
            `[headscale-integration] Auth error polling VPN for ${nodeName}: ${msg} — check HEADSCALE_API_KEY`,
          );
          return null; // bail early, retrying won't help
        }
        // Transient errors (network, timeout) — keep polling
        logger.debug(`[headscale-integration] Poll error for ${nodeName}: ${msg}`);
      }

      const terminalCandidateFailure = await options?.probeTerminalCandidateFailure?.();
      if (terminalCandidateFailure) {
        throw terminalCandidateFailure;
      }

      // Exponential backoff with jitter to avoid thundering-herd on
      // Headscale during bulk container provisioning.
      const jitter = Math.floor(Math.random() * interval * 0.3);
      const sleepMs = Math.min(interval + jitter, deadline - Date.now());
      if (sleepMs <= 0) break;
      await sleep(sleepMs);
      interval = Math.min(interval * 1.5, POLL_INTERVAL_MAX_MS);
    }

    logger.warn(`[headscale-integration] VPN registration timeout for ${nodeName}`);
    return null;
  }

  /**
   * Clean up the VPN node when a container is deleted.
   *
   * Finds the node by hostname and deletes it from the Headscale network.
   * Silently succeeds if the node was already removed.
   */
  async cleanupContainerVPN(nodeName: string): Promise<void> {
    logger.info(`[headscale-integration] cleaning up VPN node for ${nodeName}`);

    try {
      // Strict lookup (#16565): the lossy variant swallows API errors into
      // "no node", silently leaking a persistent node. Failures now land in
      // the catch below — logged, still non-blocking for container deletion.
      const node = await this.client.getNodeByNameStrict(nodeName);

      if (!node) {
        logger.info(
          `[headscale-integration] no VPN node found for ${nodeName}, nothing to clean up`,
        );
        return;
      }

      await this.client.deleteNode(node.id);
      logger.info(`[headscale-integration] VPN node cleaned up for ${nodeName}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[headscale-integration] error cleaning up VPN for ${nodeName}:`, msg);
      // Do not rethrow because Headscale deletion failures should not block container deletion
    }
  }

  /**
   * Delete a VPN node by its Headscale id — the only safe identifier during a
   * blue/green overlap, where old and new nodes share the deterministic
   * hostname (#16565). Best-effort like {@link cleanupContainerVPN}: a
   * deletion failure must not block the container lifecycle, and an
   * already-gone node (404) counts as success in the client.
   */
  async removeVpnNodeById(nodeId: string): Promise<void> {
    try {
      await this.client.deleteNode(nodeId);
      logger.info(`[headscale-integration] VPN node ${nodeId} removed by id`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[headscale-integration] error removing VPN node ${nodeId}:`, msg);
    }
  }

  /**
   * Get the VPN IP for a running container.
   *
   * @returns The first VPN IP, or `null` if the node isn't registered.
   */
  async getContainerVPNIP(nodeName: string): Promise<string | null> {
    try {
      return await this.client.getNodeIP(nodeName);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[headscale-integration] error getting VPN IP for ${nodeName}:`, msg);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function inferHeadscaleUser(
  input: Pick<PrepareContainerVPNInput, "agentName" | "organizationId" | "userId">,
): string {
  const organization = normalizeHeadscaleSegment(input.organizationId);
  if (organization) return `org-${organization}`;
  const user = normalizeHeadscaleSegment(input.userId);
  if (user) return `user-${user}`;
  const agentName = normalizeHeadscaleSegment(input.agentName);
  if (agentName) return `agent-${agentName}`;
  return process.env.HEADSCALE_USER || "agent";
}

export function inferTailscaleHostname(
  input: Pick<PrepareContainerVPNInput, "agentId" | "agentName">,
): string {
  const name = normalizeHeadscaleSegment(input.agentName);
  const id = normalizeHeadscaleSegment(input.agentId);
  const suffix = id ? id.slice(0, 12) : "agent";
  const base = name || "agent";
  return `${base}-${suffix}`.slice(0, 63).replace(/-+$/g, "") || "agent";
}

export function normalizeHeadscaleSegment(value: string | undefined): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default singleton instance. */
export const headscaleIntegration = new HeadscaleIntegration();
