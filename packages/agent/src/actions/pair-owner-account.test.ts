/**
 * PAIR_OWNER_ACCOUNT action coverage: intent matching, connector resolution,
 * and the handler's authorization + issuance paths. Authorization runs through
 * the REAL core role machinery (hasOwnerAccess → hasRoleAccess →
 * resolveCanonicalOwnerId) against a deterministic runtime stand-in, so the
 * owner/non-owner split is resolved, not stubbed.
 */
import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { OwnerBindingService } from "../services/owner-binding.ts";
import {
  messageWantsOwnerPairing,
  pairOwnerAccountAction,
  resolveRequestedPairConnector,
} from "./pair-owner-account.ts";

async function runHandler(
  runtime: IAgentRuntime,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const result = await pairOwnerAccountAction.handler(
    runtime,
    message,
    undefined,
    undefined,
    callback,
  );
  if (!result) {
    throw new Error("handler returned no result");
  }
  return result;
}

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const OWNER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;
const STRANGER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;
const ROOM_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd" as UUID;

function makeRuntime(options?: {
  ownerConfigured?: boolean;
  service?: unknown;
}): IAgentRuntime {
  const ownerConfigured = options?.ownerConfigured ?? true;
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: (key: string) =>
      ownerConfigured && key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
    getService: (type: string) =>
      type === "OWNER_BIND_VERIFY" ? (options?.service ?? null) : null,
    getRoom: async () => null,
    getEntityById: async () => null,
    createEntity: async () => true,
    updateEntity: async () => undefined,
    getRelationships: async () => [],
    reportError: vi.fn(),
  };
  return runtime as unknown as IAgentRuntime;
}

function makeMessage(text: string, entityId: UUID): Memory {
  return {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as UUID,
    entityId,
    roomId: ROOM_ID,
    content: { text, source: "client_chat" },
  } as Memory;
}

describe("messageWantsOwnerPairing", () => {
  it("matches pair/link intent naming a supported connector", () => {
    expect(messageWantsOwnerPairing("link my discord")).toBe(true);
    expect(messageWantsOwnerPairing("pair my Telegram account")).toBe(true);
    expect(messageWantsOwnerPairing("verify my discord so you know me")).toBe(
      true,
    );
  });

  it("does not match unrelated link/connect phrasing", () => {
    expect(messageWantsOwnerPairing("link this doc to the report")).toBe(false);
    expect(messageWantsOwnerPairing("connect the printer")).toBe(false);
    expect(messageWantsOwnerPairing("discord is down today")).toBe(false);
    expect(messageWantsOwnerPairing("")).toBe(false);
  });
});

describe("resolveRequestedPairConnector", () => {
  it("resolves a single named connector", () => {
    expect(resolveRequestedPairConnector("link my discord")?.connector).toBe(
      "discord",
    );
    expect(resolveRequestedPairConnector("pair telegram")?.connector).toBe(
      "telegram",
    );
  });

  it("returns null when no or multiple connectors are named", () => {
    expect(resolveRequestedPairConnector("link my account")).toBeNull();
    expect(
      resolveRequestedPairConnector("link my discord and telegram"),
    ).toBeNull();
  });
});

describe("pairOwnerAccountAction.validate", () => {
  it("gates on pairing intent in the message text", async () => {
    const runtime = makeRuntime();
    expect(
      await pairOwnerAccountAction.validate(
        runtime,
        makeMessage("link my discord", OWNER_ID),
      ),
    ).toBe(true);
    expect(
      await pairOwnerAccountAction.validate(
        runtime,
        makeMessage("what's the weather", OWNER_ID),
      ),
    ).toBe(false);
  });
});

describe("pairOwnerAccountAction.handler", () => {
  it("issues a discord code for the canonical owner with the exact command", async () => {
    const runtime = makeRuntime();
    const service = new OwnerBindingService(runtime);
    const runtimeWithService = makeRuntime({ service });
    const callback = vi.fn();

    const result = await runHandler(
      runtimeWithService,
      makeMessage("link my discord", OWNER_ID),
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.text).toMatch(/\/eliza-pair \d{6}/);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/\d{6}/) }),
    );
    expect(result.data).toMatchObject({ connector: "discord" });
  });

  it("uses the underscore command for telegram", async () => {
    const runtime = makeRuntime();
    const service = new OwnerBindingService(runtime);
    const runtimeWithService = makeRuntime({ service });

    const result = await runHandler(
      runtimeWithService,
      makeMessage("pair my telegram", OWNER_ID),
    );
    expect(result.success).toBe(true);
    expect(result.text).toMatch(/\/eliza_pair \d{6}/);
  });

  it("refuses a sender who does not resolve to the owner (imposter)", async () => {
    const runtime = makeRuntime();
    const service = new OwnerBindingService(runtime);
    const runtimeWithService = makeRuntime({ service });
    const callback = vi.fn();

    const result = await runHandler(
      runtimeWithService,
      makeMessage("link my discord", STRANGER_ID),
      callback,
    );

    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "NOT_OWNER" });
    // No code is ever revealed to a non-owner.
    expect(result.text).not.toMatch(/\d{6}/);
  });

  it("asks which connector when the request is ambiguous", async () => {
    const runtime = makeRuntime();
    const service = new OwnerBindingService(runtime);
    const runtimeWithService = makeRuntime({ service });

    const result = await runHandler(
      runtimeWithService,
      makeMessage("link my discord and telegram", OWNER_ID),
    );
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "CONNECTOR_AMBIGUOUS" });
  });

  it("fails with a designed message when the pairing service is absent", async () => {
    const runtime = makeRuntime();
    const result = await runHandler(
      runtime,
      makeMessage("link my discord", OWNER_ID),
    );
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "SERVICE_UNAVAILABLE" });
  });

  it("surfaces issuance failures without leaking internals", async () => {
    const throwingService = {
      beginOwnerBind: () => {
        throw new Error("no canonical owner");
      },
    };
    const runtime = makeRuntime({ service: throwingService });
    const result = await runHandler(
      runtime,
      makeMessage("link my discord", OWNER_ID),
    );
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "ISSUE_FAILED" });
    expect(
      (runtime as unknown as { reportError: ReturnType<typeof vi.fn> })
        .reportError,
    ).toHaveBeenCalled();
  });

  it("declares an OWNER role gate for planner exposure", () => {
    expect(pairOwnerAccountAction.roleGate).toEqual({ minRole: "OWNER" });
  });
});
