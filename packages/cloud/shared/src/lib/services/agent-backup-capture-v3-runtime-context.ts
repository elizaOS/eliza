/**
 * Resolves the independently revalidatable production authority used by the
 * manifest-v3 capture executor. Every value comes from the exact reserved
 * sandbox/node/vault generation; no provider enrollment or activation writer
 * lives in this module.
 */

import { isIP } from "node:net";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupManifestV3 } from "@elizaos/shared";
import { and, eq, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import type { AgentBackupOperationClaim } from "../../db/repositories/agent-backup-catalog";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { assertSafeOutboundUrl } from "../security/outbound-url";
import type {
  AgentBackupCaptureV2CatalogExecutionContext,
  AgentBackupCaptureV2RuntimeAttestation,
  ResolveAgentBackupCaptureV2CatalogExecutionContext,
} from "./agent-backup-capture-v2-catalog-executor";
import type { AgentBackupCaptureV3KeyBundleProvider } from "./agent-backup-capture-v2-pipeline";
import type { AgentBackupCaptureV3SpoolConfig } from "./agent-backup-capture-v2-spool";
import { loadAgentBackupCaptureV3VaultAuthority } from "./agent-backup-capture-v3-vault-authority";
import { decryptAgentEnvVars } from "./agent-env-crypto";

const API_TOKEN_NAMES = ["ELIZA_API_TOKEN", "ELIZAOS_API_KEY", "ELIZAOS_CLOUD_API_KEY"] as const;
const SHA256_IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESOLVED_RUNTIME_AUTHORITY_STALE_FAILURES = new WeakSet<ElizaError>();

/**
 * Only this database-backed resolver may mint stale-authority evidence. An
 * injected resolver can throw an identically shaped ElizaError, but it cannot
 * authorize irreversible catalogue settlement.
 */
export function isResolvedAgentBackupCaptureV3RuntimeAuthorityStale(
  error: unknown,
): error is ElizaError & {
  code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE";
  severity: "fatal";
} {
  return (
    error instanceof ElizaError &&
    error.code === "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE" &&
    error.severity === "fatal" &&
    RESOLVED_RUNTIME_AUTHORITY_STALE_FAILURES.has(error)
  );
}

export interface AgentBackupCaptureV3RuntimeMetadata {
  agentSchemaVersion: string;
  databaseSchemaVersion: string;
  plugins: readonly { id: string; version: string }[];
}

export interface AgentBackupCaptureV3RuntimeAuthority {
  organizationId: string;
  /** Durable `agent_sandboxes.id` used by the backup catalogue. */
  catalogAgentId: string;
  /** Runtime `agent_sandboxes.character_id` accepted by `/api/snapshot/v2`. */
  runtimeAgentId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  status: string;
  activationPhase: string | null;
  source: AgentBackupManifestV3["source"];
  imageDigest: string;
  providerHandle: string;
  bridgeUrl: string | null;
  bridgePort: number | null;
  headscaleIp: string | null;
  nodeHostname: string;
  environmentVars: Record<string, string>;
}

export interface AgentBackupCaptureV3RuntimeContextDependencies {
  loadAuthority(input: {
    claim: Readonly<AgentBackupOperationClaim>;
    signal?: AbortSignal;
  }): Promise<AgentBackupCaptureV3RuntimeAuthority>;
  loadVaultAuthority: typeof loadAgentBackupCaptureV3VaultAuthority;
  decryptEnvironmentVars: typeof decryptAgentEnvVars;
  authorizePublicUrl(rawUrl: string): Promise<URL>;
}

export interface AgentBackupCaptureV3RuntimeContextConfig {
  spool: Readonly<AgentBackupCaptureV3SpoolConfig>;
  keyBundle: AgentBackupCaptureV3KeyBundleProvider;
  runtime: Readonly<AgentBackupCaptureV3RuntimeMetadata>;
}

function contextError(code: string, message: string, cause?: unknown): never {
  throw new ElizaError(message, { code, cause, severity: "fatal" });
}

function resolvedRuntimeAuthorityStale(message: string, cause?: unknown): never {
  const error = new ElizaError(message, {
    code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
    cause,
    severity: "fatal",
  });
  RESOLVED_RUNTIME_AUTHORITY_STALE_FAILURES.add(error);
  throw error;
}

function requireClaimIdentity(claim: Readonly<AgentBackupOperationClaim>): {
  organizationId: string;
  agentId: string;
  sandboxRecordId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  providerHandle: string;
} {
  const backup = claim.backup;
  if (
    !backup.catalog_organization_id ||
    !backup.catalog_agent_id ||
    !backup.sandbox_record_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null ||
    !backup.source_provider_handle
  ) {
    contextError(
      "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_INCOMPLETE",
      "Capture claim is missing its exact sandbox runtime authority",
    );
  }
  return {
    organizationId: backup.catalog_organization_id,
    agentId: backup.catalog_agent_id,
    sandboxRecordId: backup.sandbox_record_id,
    activationGeneration: backup.lifecycle_generation,
    lifecycleRevision: backup.lifecycle_revision.toString(),
    providerHandle: backup.source_provider_handle,
  };
}

async function loadRuntimeAuthority(input: {
  claim: Readonly<AgentBackupOperationClaim>;
  signal?: AbortSignal;
}): Promise<AgentBackupCaptureV3RuntimeAuthority> {
  input.signal?.throwIfAborted();
  const identity = requireClaimIdentity(input.claim);
  const sourceRecordId = input.claim.backup.source_node_record_id;
  if (!sourceRecordId) {
    contextError(
      "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_INCOMPLETE",
      "Capture claim is missing its exact node record authority",
    );
  }
  const [row] = await dbWrite
    .select({
      organizationId: agentSandboxes.organization_id,
      catalogAgentId: agentSandboxes.id,
      runtimeAgentId: agentSandboxes.character_id,
      status: agentSandboxes.status,
      activationGeneration: agentSandboxes.activation_generation,
      activationLifecycleRevision: sql<
        string | null
      >`${agentSandboxes.activation_lifecycle_revision}::text`,
      lifecycleRevision: sql<string>`${agentSandboxes.lifecycle_revision}::text`,
      activationPhase: agentSandboxes.activation_phase,
      activationContainerId: agentSandboxes.activation_container_id,
      activationNodeId: agentSandboxes.activation_node_id,
      activationImageDigest: agentSandboxes.activation_image_digest,
      providerHandle: agentSandboxes.sandbox_id,
      bridgeUrl: agentSandboxes.bridge_url,
      bridgePort: agentSandboxes.bridge_port,
      headscaleIp: agentSandboxes.headscale_ip,
      environmentVars: agentSandboxes.environment_vars,
      nodeRecordId: dockerNodes.id,
      nodeId: dockerNodes.node_id,
      nodeHostname: dockerNodes.hostname,
      fleetKind: dockerNodes.fleet_kind,
      infrastructureProvider: dockerNodes.infrastructure_provider,
      providerServerId: dockerNodes.provider_server_id,
      nodeIncarnation: dockerNodes.node_incarnation,
    })
    .from(agentSandboxes)
    .innerJoin(
      dockerNodes,
      and(eq(dockerNodes.id, sourceRecordId), eq(dockerNodes.node_id, agentSandboxes.node_id)),
    )
    .where(
      and(
        eq(agentSandboxes.id, identity.sandboxRecordId),
        eq(agentSandboxes.organization_id, identity.organizationId),
      ),
    )
    .limit(1);
  input.signal?.throwIfAborted();
  if (
    !row ||
    row.catalogAgentId !== identity.agentId ||
    row.status !== "running" ||
    row.activationPhase !== "active" ||
    row.activationGeneration !== identity.activationGeneration ||
    row.activationLifecycleRevision !== identity.lifecycleRevision ||
    row.lifecycleRevision !== identity.lifecycleRevision ||
    !row.activationContainerId ||
    !row.activationNodeId ||
    !row.activationImageDigest ||
    !row.providerHandle ||
    !row.nodeIncarnation ||
    row.infrastructureProvider !== "hetzner" ||
    (row.fleetKind !== "robot" && row.fleetKind !== "cloud")
  ) {
    resolvedRuntimeAuthorityStale(
      "Reserved capture source is no longer the exact active sandbox generation",
    );
  }
  if (!row.runtimeAgentId) {
    contextError(
      "AGENT_BACKUP_V3_RUNTIME_IDENTITY_MISSING",
      "Exact active sandbox has no runtime character identity",
    );
  }
  if (
    row.providerHandle !== identity.providerHandle ||
    !SHA256_IMAGE_PATTERN.test(row.activationImageDigest)
  ) {
    resolvedRuntimeAuthorityStale("Reserved capture provider handle or image authority changed");
  }
  const source: AgentBackupManifestV3["source"] =
    row.fleetKind === "robot"
      ? {
          kind: "robot",
          provider: "hetzner",
          nodeRecordId: row.nodeRecordId,
          nodeId: row.activationNodeId,
          nodeIncarnation: row.nodeIncarnation,
          containerId: row.activationContainerId,
        }
      : row.providerServerId
        ? {
            kind: "cloud",
            provider: "hetzner",
            nodeRecordId: row.nodeRecordId,
            nodeId: row.activationNodeId,
            nodeIncarnation: row.nodeIncarnation,
            containerId: row.activationContainerId,
            providerServerId: row.providerServerId,
          }
        : resolvedRuntimeAuthorityStale("Cloud capture source lost its provider server authority");
  return {
    organizationId: row.organizationId,
    catalogAgentId: row.catalogAgentId,
    runtimeAgentId: row.runtimeAgentId,
    activationGeneration: row.activationGeneration,
    lifecycleRevision: row.lifecycleRevision,
    status: row.status,
    activationPhase: row.activationPhase,
    source,
    imageDigest: row.activationImageDigest,
    providerHandle: row.providerHandle,
    bridgeUrl: row.bridgeUrl,
    bridgePort: row.bridgePort,
    headscaleIp: row.headscaleIp,
    nodeHostname: row.nodeHostname,
    environmentVars: row.environmentVars,
  };
}

const DEFAULT_DEPENDENCIES: AgentBackupCaptureV3RuntimeContextDependencies = {
  loadAuthority: loadRuntimeAuthority,
  loadVaultAuthority: loadAgentBackupCaptureV3VaultAuthority,
  decryptEnvironmentVars: decryptAgentEnvVars,
  authorizePublicUrl: assertSafeOutboundUrl,
};

function sameSource(
  left: Readonly<AgentBackupManifestV3["source"]>,
  right: Readonly<AgentBackupManifestV3["source"]>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildAttestation(
  authority: Readonly<AgentBackupCaptureV3RuntimeAuthority>,
  runtime: Readonly<AgentBackupCaptureV3RuntimeMetadata>,
): AgentBackupCaptureV2RuntimeAttestation {
  return {
    organizationId: authority.organizationId,
    catalogAgentId: authority.catalogAgentId,
    runtimeAgentId: authority.runtimeAgentId,
    activationGeneration: authority.activationGeneration,
    lifecycleRevision: authority.lifecycleRevision,
    source: authority.source,
    runtime: {
      imageDigest: authority.imageDigest,
      agentSchemaVersion: runtime.agentSchemaVersion,
      databaseSchemaVersion: runtime.databaseSchemaVersion,
      plugins: runtime.plugins.map((plugin) => ({ ...plugin })),
    },
    watermarks: [
      { namespace: "control-plane.lifecycle-revision", value: authority.lifecycleRevision },
    ],
  };
}

async function resolveAgentApiBaseUrl(
  authority: Readonly<AgentBackupCaptureV3RuntimeAuthority>,
  dependencies: Readonly<AgentBackupCaptureV3RuntimeContextDependencies>,
): Promise<string> {
  if (authority.headscaleIp !== null) {
    const headscaleIp = authority.headscaleIp.trim();
    if (headscaleIp !== authority.headscaleIp || isIP(headscaleIp) === 0) {
      contextError(
        "AGENT_BACKUP_V3_CAPTURE_ROUTE_INVALID",
        "Exact capture source has a malformed Headscale address",
      );
    }
    if (!authority.bridgeUrl) {
      contextError(
        "AGENT_BACKUP_V3_CAPTURE_ROUTE_MISSING",
        "Headscale capture source has no canonical container bridge route",
      );
    }
    let bridge: URL;
    try {
      bridge = new URL(authority.bridgeUrl);
    } catch (cause) {
      contextError(
        "AGENT_BACKUP_V3_CAPTURE_ROUTE_INVALID",
        "Headscale capture bridge route is malformed",
        cause,
      );
    }
    if (
      (bridge.protocol !== "http:" && bridge.protocol !== "https:") ||
      !bridge.port ||
      bridge.username ||
      bridge.password ||
      bridge.search ||
      bridge.hash ||
      (bridge.pathname !== "/" && bridge.pathname !== "")
    ) {
      contextError(
        "AGENT_BACKUP_V3_CAPTURE_ROUTE_INVALID",
        "Headscale capture bridge route has no canonical container port",
      );
    }
    const bracketed = isIP(headscaleIp) === 6 ? `[${headscaleIp}]` : headscaleIp;
    return new URL(`${bridge.protocol}//${bracketed}:${bridge.port}/`).toString();
  }
  if (
    authority.bridgePort &&
    authority.bridgePort > 0 &&
    authority.bridgePort <= 65_535 &&
    authority.nodeHostname &&
    /^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/.test(authority.nodeHostname)
  ) {
    const host = authority.nodeHostname;
    const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return new URL(`http://${bracketed}:${authority.bridgePort}/`).toString();
  }
  if (!authority.bridgeUrl) {
    contextError(
      "AGENT_BACKUP_V3_CAPTURE_ROUTE_MISSING",
      "Exact capture source has no authorized bridge route",
    );
  }
  let candidate: URL;
  try {
    candidate = new URL(authority.bridgeUrl);
  } catch (cause) {
    contextError(
      "AGENT_BACKUP_V3_CAPTURE_ROUTE_INVALID",
      "Capture bridge route is malformed",
      cause,
    );
  }
  if (candidate.username || candidate.password || candidate.search || candidate.hash) {
    contextError(
      "AGENT_BACKUP_V3_CAPTURE_ROUTE_INVALID",
      "Capture bridge route contains unsupported URL authority",
    );
  }
  return (await dependencies.authorizePublicUrl(candidate.toString())).toString();
}

async function resolveApiToken(
  authority: Readonly<AgentBackupCaptureV3RuntimeAuthority>,
  dependencies: Readonly<AgentBackupCaptureV3RuntimeContextDependencies>,
): Promise<string> {
  for (const name of API_TOKEN_NAMES) {
    const stored = authority.environmentVars[name];
    if (typeof stored !== "string" || stored.length === 0) continue;
    const materialized = await dependencies.decryptEnvironmentVars({ [name]: stored });
    const token = materialized[name];
    if (
      !token ||
      token !== token.trim() ||
      /[\u0000-\u001f\u007f]/.test(token) ||
      Buffer.byteLength(token, "utf8") > 16 * 1024
    ) {
      contextError("AGENT_BACKUP_V3_CAPTURE_TOKEN_INVALID", "Capture API token is not canonical");
    }
    return token;
  }
  contextError("AGENT_BACKUP_V3_CAPTURE_TOKEN_MISSING", "Exact capture source has no API token");
}

/** Bind the production runtime resolver once to the shared spool/KMS authority. */
export function createAgentBackupCaptureV3RuntimeContextResolver(
  config: Readonly<AgentBackupCaptureV3RuntimeContextConfig>,
  dependencyOverrides: Partial<AgentBackupCaptureV3RuntimeContextDependencies> = {},
): ResolveAgentBackupCaptureV2CatalogExecutionContext {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  return async (input): Promise<AgentBackupCaptureV2CatalogExecutionContext> => {
    input.signal?.throwIfAborted();
    const authority = await dependencies.loadAuthority({
      claim: input.claim,
      signal: input.signal,
    });
    if (
      !UUID_PATTERN.test(authority.catalogAgentId) ||
      authority.catalogAgentId !== input.request.agentId ||
      !UUID_PATTERN.test(authority.runtimeAgentId)
    ) {
      contextError(
        "AGENT_BACKUP_V3_RUNTIME_IDENTITY_INVALID",
        "Database runtime authority has no exact catalogue/runtime identity binding",
      );
    }
    if (!sameSource(authority.source, input.expectedSource)) {
      contextError(
        "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_MISMATCH",
        "Database runtime authority differs from the reserved capture source",
      );
    }
    await input.heartbeat();
    const vault = await dependencies.loadVaultAuthority({
      organizationId: authority.organizationId,
      agentId: authority.catalogAgentId,
      sourceActivationGeneration: authority.activationGeneration,
    });
    input.signal?.throwIfAborted();
    const attestation = buildAttestation(authority, config.runtime);
    const agentApiBaseUrl = await resolveAgentApiBaseUrl(authority, dependencies);
    const apiToken = await resolveApiToken(authority, dependencies);
    return {
      attestation,
      async revalidateAttestation(signal) {
        signal?.throwIfAborted();
        const current = await dependencies.loadAuthority({ claim: input.claim, signal });
        if (
          current.catalogAgentId !== authority.catalogAgentId ||
          current.runtimeAgentId !== authority.runtimeAgentId
        ) {
          resolvedRuntimeAuthorityStale(
            "Catalogue/runtime identity binding changed while capture held the catalogue lease",
          );
        }
        const currentVault = await dependencies.loadVaultAuthority({
          organizationId: current.organizationId,
          agentId: current.catalogAgentId,
          sourceActivationGeneration: current.activationGeneration,
        });
        if (
          currentVault.vaultKeyAuthority.generationId !== vault.vaultKeyAuthority.generationId ||
          currentVault.vaultKeyAuthority.receiptDigest !== vault.vaultKeyAuthority.receiptDigest ||
          currentVault.kms.keyId !== vault.kms.keyId ||
          currentVault.kms.keyVersion !== vault.kms.keyVersion
        ) {
          contextError(
            "AGENT_BACKUP_V3_VAULT_AUTHORITY_CHANGED",
            "Vault/KMS authority changed while capture held the catalogue lease",
          );
        }
        return buildAttestation(current, config.runtime);
      },
      transport: { agentApiBaseUrl, apiToken },
      spool: config.spool,
      keyBundle: config.keyBundle,
      kms: vault.kms,
      vaultKeyAuthority: vault.vaultKeyAuthority,
    };
  };
}
