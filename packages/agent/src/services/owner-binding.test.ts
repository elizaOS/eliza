/**
 * OwnerBindingService (OWNER_BIND_VERIFY) unit coverage: code issuance, the
 * verification state machine (single-use, expiry, attempt caps, connector
 * isolation), and the owner-entity metadata write that role resolution keys
 * on. Runs against a deterministic in-memory runtime stand-in with an
 * injectable clock — the code/hash/compare logic under test is real.
 */
import type { Entity, IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_BIND_CODE_TTL_MS,
  OWNER_BIND_MAX_ATTEMPTS,
  OwnerBindingService,
} from "./owner-binding.ts";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const OWNER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;

type TestRuntime = IAgentRuntime & {
  _entities: Map<string, Entity>;
  reportError: ReturnType<typeof vi.fn>;
};

function makeRuntime(options?: {
  ownerConfigured?: boolean;
  updateEntityError?: Error;
}): TestRuntime {
  const entities = new Map<string, Entity>();
  const ownerConfigured = options?.ownerConfigured ?? true;
  const runtime = {
    agentId: AGENT_ID,
    _entities: entities,
    getSetting: (key: string) =>
      ownerConfigured && key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
    getEntityById: async (id: UUID) => entities.get(id) ?? null,
    createEntity: async (entity: Entity) => {
      entities.set(entity.id as string, entity);
      return true;
    },
    updateEntity: async (entity: Entity) => {
      if (options?.updateEntityError) {
        throw options.updateEntityError;
      }
      entities.set(entity.id as string, entity);
    },
    reportError: vi.fn(),
  };
  return runtime as unknown as TestRuntime;
}

function makeService(
  runtime: TestRuntime,
  clock: { now: number } = { now: 1_000_000 },
): { service: OwnerBindingService; clock: { now: number } } {
  const service = new OwnerBindingService(
    runtime as IAgentRuntime,
    () => clock.now,
  );
  return { service, clock };
}

describe("OwnerBindingService.beginOwnerBind", () => {
  it("issues a crypto-random 6-digit code with a 5-minute expiry", () => {
    const { service, clock } = makeService(makeRuntime());
    const issued = service.beginOwnerBind({ connector: "discord" });
    expect(issued.connector).toBe("discord");
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(issued.expiresAt).toBe(clock.now + OWNER_BIND_CODE_TTL_MS);
  });

  it("fails closed when no canonical owner is configured", () => {
    const { service } = makeService(makeRuntime({ ownerConfigured: false }));
    expect(() => service.beginOwnerBind({ connector: "discord" })).toThrowError(
      /no canonical owner/i,
    );
  });

  it("rejects unsupported connectors", () => {
    const { service } = makeService(makeRuntime());
    expect(() =>
      service.beginOwnerBind({
        connector: "slack" as unknown as "discord",
      }),
    ).toThrowError(/unsupported/i);
  });

  it("re-issuing replaces the previous pending code", async () => {
    const runtime = makeRuntime();
    const { service } = makeService(runtime);
    const first = service.beginOwnerBind({ connector: "discord" });
    const second = service.beginOwnerBind({ connector: "discord" });

    const staleResult = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner#1",
      code: first.code,
    });
    // The first code is only "invalid" if it differs from the second; on the
    // 1-in-a-million collision the verify legitimately succeeds.
    if (first.code !== second.code) {
      expect(staleResult).toEqual({ success: false, error: "invalid_code" });
    }
  });
});

describe("OwnerBindingService.verifyOwnerBindFromConnector", () => {
  let runtime: TestRuntime;
  let service: OwnerBindingService;
  let clock: { now: number };

  beforeEach(() => {
    runtime = makeRuntime();
    ({ service, clock } = makeService(runtime));
  });

  it("verifies a valid code and binds the platform identity to the owner entity", async () => {
    const { code } = service.beginOwnerBind({ connector: "discord" });
    const result = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "123456789012345678",
      displayHandle: "shaw",
      code,
    });
    expect(result).toEqual({ success: true });

    const owner = runtime._entities.get(OWNER_ID);
    expect(owner).toBeDefined();
    const discord = owner?.metadata?.discord as Record<string, unknown>;
    expect(discord.id).toBe("123456789012345678");
    expect(discord.userId).toBe("123456789012345678");
    expect(discord.username).toBe("shaw");
    expect(discord.name).toBe("shaw");
  });

  it("merges into an existing owner entity without dropping other metadata", async () => {
    runtime._entities.set(OWNER_ID, {
      id: OWNER_ID,
      names: ["Owner"],
      agentId: AGENT_ID,
      metadata: { default: { name: "Owner" } },
    });
    const { code } = service.beginOwnerBind({ connector: "telegram" });
    const result = await service.verifyOwnerBindFromConnector({
      connector: "telegram",
      externalId: "424242",
      displayHandle: "shaw_tg",
      code,
    });
    expect(result.success).toBe(true);
    const owner = runtime._entities.get(OWNER_ID);
    expect(owner?.metadata?.default).toEqual({ name: "Owner" });
    expect((owner?.metadata?.telegram as Record<string, unknown>).userId).toBe(
      "424242",
    );
  });

  it("falls back to the externalId as display fields for a blank handle", async () => {
    const { code } = service.beginOwnerBind({ connector: "discord" });
    await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "42",
      displayHandle: "  ",
      code,
    });
    const discord = runtime._entities.get(OWNER_ID)?.metadata
      ?.discord as Record<string, unknown>;
    expect(discord.username).toBe("42");
  });

  it("is single-use: a replayed code after success is rejected", async () => {
    const { code } = service.beginOwnerBind({ connector: "discord" });
    const first = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner",
      code,
    });
    expect(first.success).toBe(true);

    // An imposter replaying the observed code binds nothing.
    const replay = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "666",
      displayHandle: "imposter",
      code,
    });
    expect(replay).toEqual({ success: false, error: "no_pending_bind" });
    const discord = runtime._entities.get(OWNER_ID)?.metadata
      ?.discord as Record<string, unknown>;
    expect(discord.id).toBe("111");
  });

  it("rejects a wrong code but allows a later correct attempt", async () => {
    const { code } = service.beginOwnerBind({ connector: "discord" });
    const wrongCode = code === "000000" ? "000001" : "000000";
    const wrong = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "666",
      displayHandle: "imposter",
      code: wrongCode,
    });
    expect(wrong).toEqual({ success: false, error: "invalid_code" });
    expect(runtime._entities.has(OWNER_ID)).toBe(false);

    const right = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner",
      code,
    });
    expect(right.success).toBe(true);
  });

  it("invalidates the code after the attempt cap is exhausted", async () => {
    const { code } = service.beginOwnerBind({ connector: "discord" });
    const wrongCode = code === "000000" ? "000001" : "000000";

    for (let attempt = 1; attempt < OWNER_BIND_MAX_ATTEMPTS; attempt++) {
      const result = await service.verifyOwnerBindFromConnector({
        connector: "discord",
        externalId: "666",
        displayHandle: "imposter",
        code: wrongCode,
      });
      expect(result).toEqual({ success: false, error: "invalid_code" });
    }
    const last = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "666",
      displayHandle: "imposter",
      code: wrongCode,
    });
    expect(last).toEqual({ success: false, error: "too_many_attempts" });

    // Even the REAL code is dead now — brute force burns the bind.
    const real = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner",
      code,
    });
    expect(real).toEqual({ success: false, error: "no_pending_bind" });
  });

  it("rejects an expired code", async () => {
    const { code } = service.beginOwnerBind({ connector: "discord" });
    clock.now += OWNER_BIND_CODE_TTL_MS + 1;
    const result = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner",
      code,
    });
    expect(result).toEqual({ success: false, error: "code_expired" });
  });

  it("isolates pending codes per connector", async () => {
    const { code } = service.beginOwnerBind({ connector: "discord" });
    const crossConnector = await service.verifyOwnerBindFromConnector({
      connector: "telegram",
      externalId: "111",
      displayHandle: "owner",
      code,
    });
    expect(crossConnector).toEqual({
      success: false,
      error: "no_pending_bind",
    });
  });

  it("rejects malformed input without consuming attempts", async () => {
    const { code } = service.beginOwnerBind({ connector: "discord" });

    expect(
      await service.verifyOwnerBindFromConnector({
        connector: "discord",
        externalId: "111",
        displayHandle: "owner",
        code: "12345",
      }),
    ).toEqual({ success: false, error: "invalid_code_format" });
    expect(
      await service.verifyOwnerBindFromConnector({
        connector: "discord",
        externalId: "",
        displayHandle: "owner",
        code,
      }),
    ).toEqual({ success: false, error: "invalid_external_id" });
    expect(
      await service.verifyOwnerBindFromConnector({
        connector: "slack" as unknown as "discord",
        externalId: "111",
        displayHandle: "owner",
        code,
      }),
    ).toEqual({ success: false, error: "invalid_connector" });

    // None of the malformed submissions burned the pending bind.
    const real = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner",
      code,
    });
    expect(real.success).toBe(true);
  });

  it("verifying with no pending bind fails", async () => {
    const result = await service.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner",
      code: "123456",
    });
    expect(result).toEqual({ success: false, error: "no_pending_bind" });
  });

  it("consumes the code and reports when the binding write fails", async () => {
    const failingRuntime = makeRuntime({
      updateEntityError: new Error("db down"),
    });
    failingRuntime._entities.set(OWNER_ID, {
      id: OWNER_ID,
      names: ["Owner"],
      agentId: AGENT_ID,
      metadata: {},
    });
    const { service: failingService } = makeService(failingRuntime);
    const { code } = failingService.beginOwnerBind({ connector: "discord" });

    const result = await failingService.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner",
      code,
    });
    expect(result).toEqual({ success: false, error: "binding_write_failed" });
    expect(failingRuntime.reportError).toHaveBeenCalled();

    // Fail closed: the consumed code cannot be retried.
    const retry = await failingService.verifyOwnerBindFromConnector({
      connector: "discord",
      externalId: "111",
      displayHandle: "owner",
      code,
    });
    expect(retry).toEqual({ success: false, error: "no_pending_bind" });
  });
});
