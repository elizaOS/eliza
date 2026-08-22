import { describe, expect, test } from "bun:test";
import {
  type AgentBackupOperationClaim,
  agentBackupObjectInventoryDigest,
} from "../../db/repositories/agent-backup-catalog";
import type { AgentBackupObject } from "../../db/schemas/agent-backup-catalog";
import type { AgentBackupCatalogState } from "../../db/schemas/agent-sandboxes";
import type { AgentBackupObjectStoreRegistry } from "../storage/agent-backup-object-store";
import {
  type AgentBackupCapturedPublicationChunk,
  type AgentBackupCapturedPublicationSource,
  type AgentBackupPublicationExecutorDependencies,
  AgentBackupPublicationStageError,
  executeAgentBackupPostCapturePublication,
  executeAgentBackupPrimaryPublication,
  executeAgentBackupSecondaryReplication,
} from "./agent-backup-publication-executor";

const ORGANIZATION_ID = "a0000000-0000-4000-8000-000000000001";
const AGENT_ID = "b0000000-0000-4000-8000-000000000002";
const BACKUP_ID = "c0000000-0000-4000-8000-000000000003";
const OPERATION_ID = "d0000000-0000-4000-8000-000000000004";
const LIFECYCLE_GENERATION = "e0000000-0000-4000-8000-000000000005";
const CLAIM_GENERATION = "f0000000-0000-4000-8000-000000000006";
const MANIFEST_DIGEST = "a".repeat(64);
const UNUSED_REGISTRY = Object.freeze({}) as AgentBackupObjectStoreRegistry;

function ownedBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(input.byteLength));
  output.set(input);
  return output;
}

async function digestHex(input: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(input)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function publicationFixture() {
  const bodies = [
    ownedBytes(new TextEncoder().encode("encrypted-database-0")),
    ownedBytes(new TextEncoder().encode("encrypted-state-files-0")),
  ];
  const chunks: AgentBackupCapturedPublicationChunk[] = [
    {
      component: "database",
      chunkIndex: 0,
      contentHmacSha256: "b".repeat(64),
      ciphertextSha256: await digestHex(bodies[0] ?? new Uint8Array()),
      sizeBytes: bodies[0]?.byteLength ?? 0,
    },
    {
      component: "state-files",
      chunkIndex: 0,
      contentHmacSha256: "c".repeat(64),
      ciphertextSha256: await digestHex(bodies[1] ?? new Uint8Array()),
      sizeBytes: bodies[1]?.byteLength ?? 0,
    },
  ];
  return {
    bodies,
    chunks,
    inventoryDigest: await agentBackupObjectInventoryDigest(chunks),
  };
}

function claim(params: {
  state: AgentBackupCatalogState;
  inventoryDigest: string;
  resumeState?: AgentBackupCatalogState | null;
}): AgentBackupOperationClaim {
  return {
    ownerId: "publication-worker-1",
    generation: CLAIM_GENERATION,
    backup: {
      id: BACKUP_ID,
      catalog_organization_id: ORGANIZATION_ID,
      catalog_agent_id: AGENT_ID,
      backup_operation_id: OPERATION_ID,
      lifecycle_generation: LIFECYCLE_GENERATION,
      lifecycle_revision: 7n,
      catalog_state: params.state,
      catalog_resume_state: params.resumeState ?? null,
      catalog_attempts: 1,
      manifest_digest: MANIFEST_DIGEST,
      manifest_object_count: 2,
      object_inventory_digest: params.inventoryDigest,
    },
  } as AgentBackupOperationClaim;
}

function primaryObject(
  chunk: AgentBackupCapturedPublicationChunk,
  overrides: Partial<AgentBackupObject> = {},
): AgentBackupObject {
  return {
    organization_id: ORGANIZATION_ID,
    backup_id: BACKUP_ID,
    copy_role: "primary",
    provider: "cloudflare-r2",
    state: "verified",
    component: chunk.component,
    chunk_index: chunk.chunkIndex,
    content_hmac_sha256: chunk.contentHmacSha256,
    ciphertext_sha256: chunk.ciphertextSha256,
    size_bytes: chunk.sizeBytes,
    ...overrides,
  } as AgentBackupObject;
}

function sourceFixture(params: {
  chunks: readonly AgentBackupCapturedPublicationChunk[];
  bodies: readonly Uint8Array[];
  inventoryDigest: string;
  events: string[];
  returnedBodies: Uint8Array[];
}): AgentBackupCapturedPublicationSource {
  return {
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    backupId: BACKUP_ID,
    operationId: OPERATION_ID,
    manifestDigest: MANIFEST_DIGEST,
    objectInventoryDigest: params.inventoryDigest,
    chunks: params.chunks,
    async beginPrimaryPublication() {
      params.events.push("source-begin");
    },
    async readCiphertextChunk(chunk) {
      params.events.push(`source-read:${chunk.component}:${chunk.chunkIndex}`);
      const index = params.chunks.findIndex(
        (candidate) =>
          candidate.component === chunk.component && candidate.chunkIndex === chunk.chunkIndex,
      );
      const sourceBody = params.bodies[index];
      if (!sourceBody) throw new Error("missing test chunk body");
      const body = sourceBody.slice();
      params.returnedBodies.push(body);
      return body;
    },
    async markPrimaryChunkUploaded(chunk) {
      params.events.push(`source-uploaded:${chunk.component}:${chunk.chunkIndex}`);
    },
    async markPrimaryPublished() {
      params.events.push("source-published");
    },
    async close() {
      params.events.push("source-close");
    },
  };
}

function dependencies(params: {
  initialClaim: AgentBackupOperationClaim;
  events: string[];
  upload?: AgentBackupPublicationExecutorDependencies["uploadObject"];
  listPrimary?: AgentBackupPublicationExecutorDependencies["listVerifiedPrimaryObjects"];
  replicate?: AgentBackupPublicationExecutorDependencies["replicateObject"];
  heartbeat?: AgentBackupPublicationExecutorDependencies["heartbeatOperation"];
}): AgentBackupPublicationExecutorDependencies {
  let durableBackup = params.initialClaim.backup;
  return {
    heartbeatOperation:
      params.heartbeat ??
      (async () => {
        params.events.push("heartbeat");
      }),
    async transitionOperation(input) {
      params.events.push(`transition:${input.expectedState}->${input.to}`);
      if (durableBackup.catalog_state !== input.expectedState) {
        throw new Error("test transition CAS mismatch");
      }
      durableBackup = {
        ...durableBackup,
        catalog_state: input.to,
        catalog_resume_state: null,
      };
      return durableBackup;
    },
    listVerifiedPrimaryObjects:
      params.listPrimary ??
      (async () => {
        throw new Error("unexpected primary inventory read");
      }),
    uploadObject:
      params.upload ??
      (async () => {
        throw new Error("unexpected primary upload");
      }),
    replicateObject:
      params.replicate ??
      (async () => {
        throw new Error("unexpected secondary replication");
      }),
    now: () => Date.parse("2026-08-16T03:00:00.000Z"),
  };
}

describe("post-capture backup publication", () => {
  test("rejects an already-aborted signal at every executor entry without transition or I/O", async () => {
    const fixture = await publicationFixture();
    const capturedClaim = claim({ state: "captured", inventoryDigest: fixture.inventoryDigest });
    const primaryVerifiedClaim = claim({
      state: "primary_verified",
      inventoryDigest: fixture.inventoryDigest,
    });
    const events: string[] = [];
    const reason = new Error("publication shutdown");
    const controller = new AbortController();
    controller.abort(reason);
    const resolveSource = async (): Promise<AgentBackupCapturedPublicationSource> => {
      events.push("source-resolve");
      throw new Error("aborted publication must not resolve its source");
    };
    const abortedDependencies = dependencies({
      initialClaim: primaryVerifiedClaim,
      events,
      listPrimary: async () => {
        events.push("primary-list");
        return fixture.chunks.map((chunk) => primaryObject(chunk));
      },
      replicate: async () => {
        events.push("replicate");
        return {} as AgentBackupObject;
      },
    });

    for (const execute of [
      () =>
        executeAgentBackupPrimaryPublication({
          claim: capturedClaim,
          leaseMs: 60_000,
          scope: "production-eu",
          primaryEndpointAlias: "primary-r2",
          registry: UNUSED_REGISTRY,
          resolveSource,
          dependencies: abortedDependencies,
          signal: controller.signal,
        }),
      () =>
        executeAgentBackupSecondaryReplication({
          claim: primaryVerifiedClaim,
          leaseMs: 60_000,
          scope: "production-eu",
          secondaryEndpointAlias: "secondary-hetzner",
          registry: UNUSED_REGISTRY,
          dependencies: abortedDependencies,
          signal: controller.signal,
        }),
      () =>
        executeAgentBackupPostCapturePublication({
          claim: primaryVerifiedClaim,
          leaseMs: 60_000,
          config: {
            scope: "production-eu",
            primaryEndpointAlias: "primary-r2",
            secondaryEndpointAlias: "secondary-hetzner",
          },
          registry: UNUSED_REGISTRY,
          resolveSource,
          dependencies: abortedDependencies,
          signal: controller.signal,
        }),
    ]) {
      await expect(execute()).rejects.toBe(reason);
    }
    expect(events).toEqual([]);
  });

  test("stops between primary and secondary after abort while preserving an exact replay boundary", async () => {
    const fixture = await publicationFixture();
    const initialClaim = claim({
      state: "primary_uploaded",
      inventoryDigest: fixture.inventoryDigest,
    });
    const events: string[] = [];
    const controller = new AbortController();
    const reason = new Error("shutdown after primary source close");
    let secondaryLists = 0;
    let replications = 0;
    await expect(
      executeAgentBackupPostCapturePublication({
        claim: initialClaim,
        leaseMs: 60_000,
        config: {
          scope: "production-eu",
          primaryEndpointAlias: "primary-r2",
          secondaryEndpointAlias: "secondary-hetzner",
        },
        registry: UNUSED_REGISTRY,
        resolveSource: async () => {
          const source = sourceFixture({
            chunks: fixture.chunks,
            bodies: fixture.bodies,
            inventoryDigest: fixture.inventoryDigest,
            events,
            returnedBodies: [],
          });
          return {
            ...source,
            async close() {
              events.push("source-close");
              controller.abort(reason);
            },
          };
        },
        dependencies: dependencies({
          initialClaim,
          events,
          listPrimary: async () => {
            secondaryLists += 1;
            return fixture.chunks.map((chunk) => primaryObject(chunk));
          },
          replicate: async () => {
            replications += 1;
            return {} as AgentBackupObject;
          },
        }),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(events).toContain("transition:primary_uploaded->primary_verified");
    expect(events).not.toContain("transition:primary_verified->secondary_pending");
    expect(secondaryLists).toBe(0);
    expect(replications).toBe(0);

    const replayClaim = claim({
      state: "primary_verified",
      inventoryDigest: fixture.inventoryDigest,
    });
    const replayed = await executeAgentBackupPostCapturePublication({
      claim: replayClaim,
      leaseMs: 60_000,
      config: {
        scope: "production-eu",
        primaryEndpointAlias: "primary-r2",
        secondaryEndpointAlias: "secondary-hetzner",
      },
      registry: UNUSED_REGISTRY,
      resolveSource: async () => {
        throw new Error("primary-verified replay must not reopen the spool");
      },
      dependencies: dependencies({
        initialClaim: replayClaim,
        events: [],
        listPrimary: async () => fixture.chunks.map((chunk) => primaryObject(chunk)),
        replicate: async () => {
          replications += 1;
          return {} as AgentBackupObject;
        },
      }),
    });
    expect(replayed.backup.catalog_state).toBe("protected");
    expect(replications).toBe(fixture.chunks.length);
  });

  test("publishes repository-owned primary slots, journals every chunk, and zeroes spool copies", async () => {
    const fixture = await publicationFixture();
    const initialClaim = claim({ state: "captured", inventoryDigest: fixture.inventoryDigest });
    const events: string[] = [];
    const returnedBodies: Uint8Array[] = [];
    const slots: string[] = [];
    const result = await executeAgentBackupPrimaryPublication({
      claim: initialClaim,
      leaseMs: 60_000,
      scope: "production-eu",
      primaryEndpointAlias: "primary-r2",
      registry: UNUSED_REGISTRY,
      resolveSource: async ({ claim: sourceClaim }) => {
        events.push(`source-resolve:${sourceClaim.backup.catalog_state}`);
        return sourceFixture({
          chunks: fixture.chunks,
          bodies: fixture.bodies,
          inventoryDigest: fixture.inventoryDigest,
          events,
          returnedBodies,
        });
      },
      dependencies: dependencies({
        initialClaim,
        events,
        upload: async (input) => {
          expect(typeof input.revalidateLease).toBe("function");
          await input.revalidateLease?.();
          events.push(`upload:${input.component}:${input.chunkIndex}`);
          expect("objectKey" in input).toBe(false);
          expect(input.deadline).toEqual(new Date("2026-08-16T03:02:00.000Z"));
          slots.push(`${input.component}:${input.chunkIndex}:${input.copyRole}`);
          expect(input.body.some((byte) => byte !== 0)).toBe(true);
          return primaryObject(fixture.chunks[input.chunkIndex] ?? fixture.chunks[0]!);
        },
      }),
    });

    expect(result.backup.catalog_state).toBe("primary_verified");
    expect(slots).toEqual(["database:0:primary", "state-files:0:primary"]);
    expect(returnedBodies.every((body) => body.every((byte) => byte === 0))).toBe(true);
    expect(events.filter((event) => event.startsWith("source-uploaded:"))).toEqual([
      "source-uploaded:database:0",
      "source-uploaded:state-files:0",
    ]);
    expect(events.indexOf("source-resolve:captured")).toBeLessThan(
      events.indexOf("transition:captured->uploading"),
    );
    expect(events.at(-1)).toBe("source-close");
  });

  test("replays repository-owned slots after crash on chunk N and resumes the exact failed state", async () => {
    const fixture = await publicationFixture();
    const firstClaim = claim({ state: "captured", inventoryDigest: fixture.inventoryDigest });
    const events: string[] = [];
    const slots: string[] = [];
    let uploadAttempt = 0;
    const shared = {
      events,
      upload: async (
        input: Parameters<AgentBackupPublicationExecutorDependencies["uploadObject"]>[0],
      ) => {
        expect("objectKey" in input).toBe(false);
        slots.push(`${input.component}:${input.chunkIndex}:${input.copyRole}`);
        uploadAttempt += 1;
        if (uploadAttempt === 2) throw new Error("crash while uploading chunk 1");
        return primaryObject(fixture.chunks[input.chunkIndex] ?? fixture.chunks[0]!);
      },
    };
    await expect(
      executeAgentBackupPrimaryPublication({
        claim: firstClaim,
        leaseMs: 60_000,
        scope: "production-eu",
        primaryEndpointAlias: "primary-r2",
        registry: UNUSED_REGISTRY,
        resolveSource: async () =>
          sourceFixture({
            chunks: fixture.chunks,
            bodies: fixture.bodies,
            inventoryDigest: fixture.inventoryDigest,
            events,
            returnedBodies: [],
          }),
        dependencies: dependencies({ initialClaim: firstClaim, ...shared }),
      }),
    ).rejects.toMatchObject({
      operationState: "uploading",
      retryCode: "BACKUP_PRIMARY_PUBLICATION_RETRY",
    });

    const retryClaim = claim({
      state: "failed_retryable",
      resumeState: "uploading",
      inventoryDigest: fixture.inventoryDigest,
    });
    uploadAttempt = 2;
    const completed = await executeAgentBackupPrimaryPublication({
      claim: retryClaim,
      leaseMs: 60_000,
      scope: "production-eu",
      primaryEndpointAlias: "primary-r2",
      registry: UNUSED_REGISTRY,
      resolveSource: async () =>
        sourceFixture({
          chunks: fixture.chunks,
          bodies: fixture.bodies,
          inventoryDigest: fixture.inventoryDigest,
          events,
          returnedBodies: [],
        }),
      dependencies: dependencies({ initialClaim: retryClaim, ...shared }),
    });

    expect(completed.backup.catalog_state).toBe("primary_verified");
    expect(slots[0]).toBe(slots[2]);
    expect(slots[1]).toBe(slots[3]);
  });

  test("requires the durable agent identity before reading a capture source", async () => {
    const fixture = await publicationFixture();
    const missingAgent = claim({ state: "uploading", inventoryDigest: fixture.inventoryDigest });
    missingAgent.backup.catalog_agent_id = null;
    let resolved = false;
    await expect(
      executeAgentBackupPrimaryPublication({
        claim: missingAgent,
        leaseMs: 60_000,
        scope: "production-eu",
        primaryEndpointAlias: "primary-r2",
        registry: UNUSED_REGISTRY,
        resolveSource: async () => {
          resolved = true;
          throw new Error("must not resolve");
        },
        dependencies: dependencies({ initialClaim: missingAgent, events: [] }),
      }),
    ).rejects.toMatchObject({ code: "BACKUP_PUBLICATION_AUTHORITY_INCOMPLETE" });
    expect(resolved).toBe(false);
  });

  test("replicates only the verified persisted primary inventory without resolving the spool", async () => {
    const fixture = await publicationFixture();
    const initialClaim = claim({
      state: "primary_verified",
      inventoryDigest: fixture.inventoryDigest,
    });
    const events: string[] = [];
    const primaries = fixture.chunks.map((chunk) => primaryObject(chunk));
    const replicated: string[] = [];
    const result = await executeAgentBackupPostCapturePublication({
      claim: initialClaim,
      leaseMs: 60_000,
      config: {
        scope: "production-eu",
        primaryEndpointAlias: "primary-r2",
        secondaryEndpointAlias: "secondary-hetzner",
      },
      registry: UNUSED_REGISTRY,
      resolveSource: async () => {
        throw new Error("secondary replay must never resolve capture spool");
      },
      dependencies: dependencies({
        initialClaim,
        events,
        listPrimary: async (input) => {
          expect(input).toMatchObject({
            organizationId: ORGANIZATION_ID,
            agentId: AGENT_ID,
            backupId: BACKUP_ID,
            operationId: OPERATION_ID,
          });
          return primaries;
        },
        replicate: async (input) => {
          expect("secondaryObjectKey" in input).toBe(false);
          expect(input).toMatchObject({
            scope: "production-eu",
            operationId: OPERATION_ID,
            manifestDigest: MANIFEST_DIGEST,
          });
          replicated.push(`${input.primaryObject.component}:${input.primaryObject.chunk_index}`);
          return {} as AgentBackupObject;
        },
      }),
    });

    expect(result.backup.catalog_state).toBe("protected");
    expect(replicated).toEqual(["database:0", "state-files:0"]);
  });

  test("keeps secondary outages retryable at the exact secondary_pending boundary", async () => {
    const fixture = await publicationFixture();
    const initialClaim = claim({
      state: "secondary_pending",
      inventoryDigest: fixture.inventoryDigest,
    });
    const primaries = fixture.chunks.map((chunk) => primaryObject(chunk));
    await expect(
      executeAgentBackupSecondaryReplication({
        claim: initialClaim,
        leaseMs: 60_000,
        scope: "production-eu",
        secondaryEndpointAlias: "secondary-hetzner",
        registry: UNUSED_REGISTRY,
        dependencies: dependencies({
          initialClaim,
          events: [],
          listPrimary: async () => primaries,
          replicate: async () => {
            throw new Error("Hetzner endpoint unavailable");
          },
        }),
      }),
    ).rejects.toBeInstanceOf(AgentBackupPublicationStageError);
  });

  test("replays partial secondary rows idempotently from the persisted primary inventory", async () => {
    const fixture = await publicationFixture();
    const primaries = fixture.chunks.map((chunk) => primaryObject(chunk));
    const replicated: string[] = [];
    let failSecond = true;
    const execute = (ownedClaim: AgentBackupOperationClaim) =>
      executeAgentBackupSecondaryReplication({
        claim: ownedClaim,
        leaseMs: 60_000,
        scope: "production-eu",
        secondaryEndpointAlias: "secondary-hetzner",
        registry: UNUSED_REGISTRY,
        dependencies: dependencies({
          initialClaim: ownedClaim,
          events: [],
          listPrimary: async () => primaries,
          replicate: async (input) => {
            replicated.push(
              `${input.operationId}:${input.primaryObject.component}:${input.primaryObject.chunk_index}`,
            );
            if (failSecond && input.primaryObject.component === "state-files") {
              failSecond = false;
              throw new Error("crash on secondary chunk 1");
            }
            return {} as AgentBackupObject;
          },
        }),
      });

    await expect(
      execute(claim({ state: "secondary_pending", inventoryDigest: fixture.inventoryDigest })),
    ).rejects.toMatchObject({ operationState: "secondary_pending" });
    const completed = await execute(
      claim({
        state: "failed_retryable",
        resumeState: "secondary_pending",
        inventoryDigest: fixture.inventoryDigest,
      }),
    );

    expect(completed.backup.catalog_state).toBe("protected");
    expect(replicated).toEqual([
      `${OPERATION_ID}:database:0`,
      `${OPERATION_ID}:state-files:0`,
      `${OPERATION_ID}:database:0`,
      `${OPERATION_ID}:state-files:0`,
    ]);
  });

  test("fails closed on wrong-tenant primary rows and on an expired lease", async () => {
    const fixture = await publicationFixture();
    const initialClaim = claim({
      state: "secondary_pending",
      inventoryDigest: fixture.inventoryDigest,
    });
    const wrongTenant = fixture.chunks.map((chunk) =>
      primaryObject(chunk, { organization_id: OPERATION_ID }),
    );
    let replicated = 0;
    await expect(
      executeAgentBackupSecondaryReplication({
        claim: initialClaim,
        leaseMs: 60_000,
        scope: "production-eu",
        secondaryEndpointAlias: "secondary-hetzner",
        registry: UNUSED_REGISTRY,
        dependencies: dependencies({
          initialClaim,
          events: [],
          listPrimary: async () => wrongTenant,
          replicate: async () => {
            replicated += 1;
            return {} as AgentBackupObject;
          },
        }),
      }),
    ).rejects.toMatchObject({ operationState: "secondary_pending" });
    expect(replicated).toBe(0);

    let heartbeats = 0;
    await expect(
      executeAgentBackupSecondaryReplication({
        claim: initialClaim,
        leaseMs: 60_000,
        scope: "production-eu",
        secondaryEndpointAlias: "secondary-hetzner",
        registry: UNUSED_REGISTRY,
        dependencies: dependencies({
          initialClaim,
          events: [],
          heartbeat: async () => {
            heartbeats += 1;
            if (heartbeats === 2) throw new Error("lease expired");
          },
          listPrimary: async () => fixture.chunks.map((chunk) => primaryObject(chunk)),
          replicate: async () => {
            replicated += 1;
            return {} as AgentBackupObject;
          },
        }),
      }),
    ).rejects.toMatchObject({
      operationState: "secondary_pending",
      retryCode: "BACKUP_SECONDARY_REPLICATION_RETRY",
    });
    expect(replicated).toBe(0);
  });
});
