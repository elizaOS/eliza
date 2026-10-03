/**
 * Prepares local admission, processor policy and same-agent durable audit before
 * a measured entry initializes model plugins. The returned authority uses only
 * the attested transport; SQLite remains plaintext unless guest storage encrypts
 * it. This bootstrap does not provide network isolation or an API listener.
 */
import { join } from "node:path";
import {
  ChannelType,
  ConfidentialInferenceAuthority,
  type ConfidentialInferenceHandler,
  ElizaError,
  logger,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import {
  type ConfidentialHostConfiguration,
  createConfidentialHostPolicy,
} from "../security/confidential-host-policy.ts";
import { createConfidentialLocalAdmission } from "../security/confidential-local-admission.ts";
import { createConfidentialSQLiteAudit } from "../security/confidential-sqlite-audit.ts";
import { createAttestedInferenceFetch } from "../services/tee-attested-inference.ts";

/** The caller is measured code; handlers are exact reviewed function identities. */
export async function prepareConfidentialHost(input: {
  configuration: ConfidentialHostConfiguration;
  localEnvironment: Readonly<Record<string, string | undefined>>;
  handlers: readonly ConfidentialInferenceHandler[];
}) {
  const handlers = [...input.handlers];
  const policy = createConfidentialHostPolicy(input.configuration);
  const localAdmission = await createConfidentialLocalAdmission(
    input.localEnvironment,
  );
  const agentId = policy.config.agentId as UUID;
  const identity = {
    agentId,
    entityId: stringToUuid(`${agentId}:confidential-audit-actor`),
    roomId: stringToUuid(`${agentId}:confidential-audit-room`),
  };
  const adapter = SQLiteDatabaseAdapter.create(
    join(policy.config.stateDirectory, "agent.sqlite"),
    agentId,
  );
  let closed = false;
  function requireOpen(): void {
    if (closed) {
      throw new ElizaError("Confidential host has closed", {
        code: "CONFIDENTIAL_HOST_CLOSED",
      });
    }
  }
  function currentProfile() {
    requireOpen();
    return policy.currentProfile();
  }
  async function admit(): Promise<true> {
    requireOpen();
    await localAdmission();
    currentProfile();
    return true;
  }
  try {
    await adapter.initialize();
    await adapter.transaction(async (tx) => {
      if ((await tx.getAgentsByIds([agentId])).length === 0) {
        await tx.createAgents([
          { id: agentId, name: policy.config.character.name },
        ]);
      }
      if ((await tx.getEntitiesByIds([identity.entityId])).length === 0) {
        await tx.createEntities([
          {
            id: identity.entityId,
            agentId,
            names: ["Confidential audit actor"],
          },
        ]);
      }
      if ((await tx.getRoomsByIds([identity.roomId])).length === 0) {
        await tx.createRooms([
          {
            id: identity.roomId,
            agentId,
            type: ChannelType.SELF,
            source: "confidential-audit",
          },
        ]);
      }
    });
    // Existing identities are never overwritten to repair wrong ownership.
    const audit = await createConfidentialSQLiteAudit(adapter, identity);
    const authority = new ConfidentialInferenceAuthority({
      handlers,
      currentProfile,
      audit,
      redispatchPolicy: "deny-after-authorization",
      transport: async (url, request, context) => {
        await admit();
        const transport = createAttestedInferenceFetch({
          origin: new URL(context.route.endpoint).origin,
          policy: {
            routeId: context.route.id,
            revision: context.policyRevision,
          },
          verifier: policy.config.verifier,
          unixSocketPath: policy.config.inferenceTransport?.unixSocketPath,
          ca: policy.config.inferenceTransport?.caPem,
          beforeDispatch: async (evidence) => {
            // Both local and remote admission precede the durable intent and
            // the transport's first application credential or payload byte.
            await admit();
            await context.beforeDispatch(evidence);
            requireOpen();
          },
        });
        return transport(url, request);
      },
    });
    await admit();
    return Object.freeze({
      config: policy.config,
      adapter,
      authority,
      hostAdmission: admit,
      revokeAdmission(): void {
        closed = true;
      },
      async close(): Promise<void> {
        closed = true;
        await adapter.close();
      },
    });
  } catch (error) {
    // error-policy:J2 Startup cannot leave an admitted partial host behind.
    closed = true;
    try {
      await adapter.close();
    } catch {
      // error-policy:J6 Failed startup cleanup must not replace the primary failure.
      logger.warn("[ConfidentialHost] SQLite startup cleanup failed");
    }
    throw new ElizaError("Confidential host preparation failed", {
      code: "CONFIDENTIAL_HOST_STARTUP_REJECTED",
      cause: error,
    });
  }
}
