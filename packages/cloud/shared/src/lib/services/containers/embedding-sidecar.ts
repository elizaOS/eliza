/**
 * Node-local embedding sidecar contract: one text-embeddings-inference (TEI)
 * container per Docker node serving BGE-small so every agent on the node gets
 * local ~50ms embeddings instead of the cloud round-trip.
 *
 * THE GAP THIS CLOSES
 * The sidecar used to be hand-installed on nodes and silently vanished: an
 * autoscaled node is rebuilt from `buildContainerNodeUserData` (which never
 * installed one), and the disk-clean cycle's `docker container prune
 * --filter 'label!=ai.elizaos.managed-by'` reaps any stopped container that
 * does not carry the managed-by label — exactly what a hand-run sidecar was.
 * Nothing probed for it, so agents silently rode the cloud embedding path.
 * This module is the single source of truth all three consumers share:
 *   - `node-bootstrap.ts` (cloud-init for autoscaled nodes) installs it,
 *   - `onboard-docker-node.ts` (operator onboarding) installs it,
 *   - `docker-node-manager.ts` health checks probe it, surface its absence in
 *     node metadata / the capacity report, and self-heal it.
 *
 * Supervision is Docker-native: `--restart always` plus the bootstrap's
 * `systemctl enable --now docker` restarts the sidecar across daemon and host
 * reboots; the managed-by label keeps every reclamation path away from it.
 *
 * Agents consume it over the shared bridge network via plugin-embeddings
 * (`EMBEDDING_BASE_URL=http://eliza-embedding-sidecar:80/v1`). The server pins
 * BGE-small + CLS pooling; the provider validates 384 dimensions and performs
 * explicit L2 normalization before persistence. The immutable contract label
 * makes an old running GTE container ineligible for the idempotent fast path,
 * so the next ensure replaces it instead of silently keeping the wrong space.
 *
 * Pure command builders + parser only (no I/O), mirroring node-disk-manager:
 * the SSH/cloud-init boundary stays with the callers and everything here
 * unit-tests exhaustively.
 */

import {
  assertCanonicalEmbeddingConfig,
  CANONICAL_EMBEDDING_DIMENSION,
  CANONICAL_EMBEDDING_POOLING,
  CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
} from "@elizaos/core/edge";
import { containersEnv } from "../../config/containers-env";
import {
  CONTAINER_LABEL_MANAGED_BY,
  CONTAINER_LABEL_MANAGED_BY_VALUE,
} from "../docker-sandbox-utils";

/**
 * Fixed container name. Deliberately outside the agent naming scheme
 * (`agent-`/`cloud-container-`) so the zombie-container reaper in node
 * onboarding can never select it, and stable so agents can resolve it by DNS
 * name on the shared bridge network.
 */
export const EMBEDDING_SIDECAR_CONTAINER_NAME = "eliza-embedding-sidecar";
/** OpenAI-compatible base URL visible to managed agent containers. */
export const EMBEDDING_SIDECAR_AGENT_BASE_URL =
  `http://${EMBEDDING_SIDECAR_CONTAINER_NAME}:80/v1` as const;

/** Labels used to prove a running container matches the canonical vector space/config. */
export const EMBEDDING_SIDECAR_SPACE_LABEL = "ai.elizaos.embedding-space";
export const EMBEDDING_SIDECAR_CONFIG_LABEL = "ai.elizaos.embedding-config";

/** Host bind-mount for the TEI model cache so weights survive re-creates. */
const MODEL_CACHE_HOST_DIR = "/data/embedding-models";

/** Result of the node-side probe (see {@link buildEmbeddingSidecarProbeCmd}). */
export type EmbeddingSidecarStatus = "running" | "unresponsive" | "missing";

/**
 * Reject values that would break out of the single-line shell commands built
 * below. Image refs, model ids, network names, and the container name all fit
 * this charset; anything else is a misconfiguration worth failing loudly on
 * rather than quoting around.
 */
function assertShellSafe(value: string, label: string): string {
  if (!/^[A-Za-z0-9._/:@-]+$/.test(value)) {
    throw new Error(
      `[embedding-sidecar] ${label} "${value}" contains characters outside [A-Za-z0-9._/:@-]; refusing to build a shell command with it`,
    );
  }
  return value;
}

export interface EmbeddingSidecarConfig {
  image: string;
  modelId: string;
  hostPort: number;
  network: string;
}

/** Effective sidecar config from `containersEnv` (each value overridable). */
export function resolveEmbeddingSidecarConfig(): EmbeddingSidecarConfig {
  return {
    image: containersEnv.embeddingSidecarImage(),
    modelId: containersEnv.embeddingSidecarModelId(),
    hostPort: containersEnv.embeddingSidecarHostPort(),
    network: containersEnv.dockerNetwork(),
  };
}

/**
 * Idempotent single-line command that guarantees the sidecar is running:
 * a healthy running sidecar is left untouched (so re-runs are free), anything
 * else (stopped, crashed, half-created) is replaced with a fresh container at
 * the currently pinned image/config. The final `docker run` exit code is the
 * command's exit code, so callers can distinguish "ensured" from "failed".
 *
 * The port publish binds loopback only — the HTTP surface reachable from off
 * the node is nothing; agents reach the sidecar via the shared bridge network,
 * and the health probe reaches it via 127.0.0.1.
 */
export function buildEnsureEmbeddingSidecarCmd(
  config: EmbeddingSidecarConfig = resolveEmbeddingSidecarConfig(),
): string {
  const name = EMBEDDING_SIDECAR_CONTAINER_NAME;
  const image = assertShellSafe(config.image, "image");
  const modelId = assertShellSafe(config.modelId, "model id");
  const network = assertShellSafe(config.network, "network");
  const port = config.hostPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[embedding-sidecar] invalid host port: ${port}`);
  }
  assertCanonicalEmbeddingConfig(
    modelId,
    CANONICAL_EMBEDDING_DIMENSION,
    CANONICAL_EMBEDDING_POOLING,
  );
  const space = assertShellSafe(
    CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
    "embedding space fingerprint",
  );
  const configIdentity = assertShellSafe(
    `${image}@${space}@${network}@${port}`,
    "immutable config identity",
  );
  const expectedInspect = `true|${space}|${configIdentity}`;
  return (
    `docker inspect -f '{{.State.Running}}|{{index .Config.Labels "${EMBEDDING_SIDECAR_SPACE_LABEL}"}}|{{index .Config.Labels "${EMBEDDING_SIDECAR_CONFIG_LABEL}"}}' ${name} 2>/dev/null | grep -Fqx '${expectedInspect}' || { ` +
    // `|| true` on rm/pull: a missing container / transient pull failure must
    // not mask the `docker run` verdict (run pulls implicitly when needed).
    `docker rm -f ${name} >/dev/null 2>&1 || true; ` +
    `docker pull ${image} >/dev/null 2>&1 || true; ` +
    `docker run -d --name ${name} --restart always ` +
    `--label ${CONTAINER_LABEL_MANAGED_BY}=${CONTAINER_LABEL_MANAGED_BY_VALUE} ` +
    `--label ${EMBEDDING_SIDECAR_SPACE_LABEL}=${space} ` +
    `--label ${EMBEDDING_SIDECAR_CONFIG_LABEL}=${configIdentity} ` +
    `--network ${network} -p 127.0.0.1:${port}:80 ` +
    `-v ${MODEL_CACHE_HOST_DIR}:/data ${image} ` +
    `--model-id ${modelId} --pooling ${CANONICAL_EMBEDDING_POOLING}; }`
  );
}

/**
 * Single-line probe emitting exactly one of the {@link EmbeddingSidecarStatus}
 * tokens: `missing` (no running container), `unresponsive` (container runs but
 * TEI's `/health` does not answer 200 within 5s — e.g. still downloading the
 * model, or wedged), `running` (serving). HTTP-level on purpose: a container
 * that is "up" but cannot embed must not read as present.
 */
export function buildEmbeddingSidecarProbeCmd(
  hostPort: number = containersEnv.embeddingSidecarHostPort(),
): string {
  const name = EMBEDDING_SIDECAR_CONTAINER_NAME;
  const expectedSpace = assertShellSafe(
    CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
    "embedding space fingerprint",
  );
  return (
    `docker inspect -f '{{.State.Running}}|{{index .Config.Labels "${EMBEDDING_SIDECAR_SPACE_LABEL}"}}' ${name} 2>/dev/null | grep -Fqx 'true|${expectedSpace}'` +
    ` && { curl -fsS -m 5 http://127.0.0.1:${hostPort}/health >/dev/null 2>&1 && echo running || echo unresponsive; }` +
    ` || echo missing`
  );
}

/**
 * Parse the probe output (tolerant of `[stderr]` lines and shell noise the SSH
 * transport may interleave). Returns null when no status token is present —
 * an unusable probe, distinct from every real verdict, so the caller can log
 * it instead of misfiling it as any of the three real states.
 */
export function parseEmbeddingSidecarProbe(output: string): EmbeddingSidecarStatus | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[stderr]"));
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === "running" || line === "unresponsive" || line === "missing") {
      return line;
    }
  }
  return null;
}

/**
 * Read the last persisted sidecar verdict off a node's `docker_nodes.metadata`
 * (written by the health loop). `"unknown"` = never probed (pre-rollout rows).
 */
export function embeddingSidecarStatusFromMetadata(
  metadata: unknown,
): EmbeddingSidecarStatus | "unknown" {
  if (!metadata || typeof metadata !== "object") return "unknown";
  const entry = (metadata as Record<string, unknown>).embeddingSidecar;
  if (!entry || typeof entry !== "object") return "unknown";
  const status = (entry as Record<string, unknown>).status;
  if (status === "running" || status === "unresponsive" || status === "missing") {
    return status;
  }
  return "unknown";
}
