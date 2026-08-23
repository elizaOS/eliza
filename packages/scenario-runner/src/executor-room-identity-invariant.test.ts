/**
 * Room-identity parity between what a scenario's seeds READ and what its turns
 * are SENT AS, plus the scoping of the configured owner set. Both are executor
 * invariants that no scenario file may restate.
 *
 * `rooms[].account` is hashed into an entity id by `resolveScenarioRooms`
 * alone, and that recipe has already moved once (#24842 namespaced accounts per
 * scenario: `scenario-account:<account>` became
 * `scenario-account:<scenarioId>:<account>`). Scenarios that spelled the old
 * recipe out a second time kept stamping roles and rows onto an entity nobody
 * speaks as, so every scoped read missed and owner-only walls were never
 * reached — the seed/runtime identity fork of #25009, one layer up. Seeds must
 * therefore read `ctx.roomEntityIds` / `ctx.accountEntityIds` / `ctx.roomIds`,
 * and those must equal the identity stamped on that room's turn messages.
 *
 * The owner set has the mirrored hazard: `ELIZA_OWNER_CONTACTS_JSON` feeds
 * `roles.ts getConfiguredOwnerEntityIds`, which grants OWNER to every id it
 * lists. Publishing every room there makes a scenario's deliberately non-owner
 * room resolve as OWNER, and every owner-only refusal in the corpus passes
 * vacuously. Only the owner's own linked accounts — rooms resolving to the
 * primary room's canonical entity — belong in it.
 *
 * Real `runScenario` against the stubbed runtime the executor suite uses; the
 * derivations under test are the executor's own.
 */
import type {
  Action,
  AgentRuntime,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioContext } from "../schema/index.d.ts";
import { runScenario } from "./executor";

type OwnerContactEntry = { entityId: string; source: string };

function createIdentityRuntime(
  onTurn: (roomKey: string, message: Memory) => void,
  settings: Map<string, unknown>,
): AgentRuntime {
  const probe: Action = {
    name: "IDENTITY_PROBE",
    description: "Records the identity the executor stamps on a turn.",
    validate: async () => true,
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state: unknown,
      options: Record<string, unknown> | undefined,
    ) => {
      onTurn(String(options?.roomKey), message);
      return { success: true, text: "recorded" };
    },
  } as Action;

  return {
    actions: [probe],
    agentId: "00000000-0000-4000-8000-000000000001",
    plugins: [],
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getEntityById: vi.fn(async () => null),
    createEntity: vi.fn(async () => true),
    getRelationships: vi.fn(async () => []),
    createRelationship: vi.fn(async () => true),
    getService: vi.fn(() => null),
    reportError: vi.fn(),
    setSetting: vi.fn((key: string, value: unknown) => {
      settings.set(key, value);
    }),
    useModel: vi.fn() as AgentRuntime["useModel"],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

function ownerContacts(
  settings: Map<string, unknown>,
): Record<string, OwnerContactEntry> {
  const raw = settings.get("ELIZA_OWNER_CONTACTS_JSON");
  if (typeof raw !== "string") {
    throw new Error("executor did not publish ELIZA_OWNER_CONTACTS_JSON");
  }
  return JSON.parse(raw) as Record<string, OwnerContactEntry>;
}

describe("scenario room identity invariant (seed scope == turn scope)", () => {
  it("publishes the same entity a room's turns are sent as, for a prefixed account", async () => {
    const scenarioId = "room-identity-invariant";
    const turnMessages = new Map<string, Memory>();
    const settings = new Map<string, unknown>();
    const runtime = createIdentityRuntime(
      (roomKey, message) => turnMessages.set(roomKey, message),
      settings,
    );
    let seedContext: ScenarioContext | undefined;

    const report = await runScenario(
      {
        id: scenarioId,
        title: "Room identity invariant",
        domain: "executor",
        rooms: [
          { id: "main", source: "client_chat", title: "Owner" },
          {
            id: "guest",
            // The shape that forked: an authored account that already carries
            // the scenario id, so a hand-rolled
            // `scenario-account:<scenarioId>:guest` and the executor's
            // `scenario-account:<scenarioId>:<account>` disagree.
            account: `${scenarioId}:guest`,
            source: "client_chat",
            title: "Guest",
          },
          {
            // A linked account: same canonical entity as `main`, different
            // connector principal. Here `canonicalEntityId` and `userId`
            // genuinely differ, so publishing the wrong one is observable —
            // turns are sent as the connector principal, never the canonical
            // alias.
            id: "linked",
            account: "linked-telegram",
            entity: "owner",
            source: "telegram",
            title: "Owner on Telegram",
          },
        ],
        seed: [
          {
            type: "custom",
            name: "capture published topology",
            apply(ctx) {
              seedContext = ctx;
            },
          },
        ],
        turns: [
          {
            kind: "action",
            name: "owner turn",
            actionName: "IDENTITY_PROBE",
            room: "main",
            text: "owner speaks",
            options: { roomKey: "main" },
          },
          {
            kind: "action",
            name: "guest turn",
            actionName: "IDENTITY_PROBE",
            room: "guest",
            text: "guest speaks",
            options: { roomKey: "guest" },
          },
          {
            kind: "action",
            name: "linked-account turn",
            actionName: "IDENTITY_PROBE",
            room: "linked",
            text: "owner speaks on telegram",
            options: { roomKey: "linked" },
          },
        ],
      },
      runtime,
      { minJudgeScore: 0.8, providerName: "unit-test", turnTimeoutMs: 1_000 },
    );

    expect(report.status).toBe("passed");

    for (const roomKey of ["main", "guest", "linked"]) {
      const message = turnMessages.get(roomKey);
      expect(message, `no turn recorded for room ${roomKey}`).toBeDefined();
      // The invariant: what a seed reads IS what the turn is sent as.
      expect(seedContext?.roomEntityIds?.[roomKey]).toBe(message?.entityId);
      expect(seedContext?.roomIds?.[roomKey]).toBe(message?.roomId);
    }

    const guestEntityId = turnMessages.get("guest")?.entityId;
    expect(seedContext?.accountEntityIds?.[`${scenarioId}:guest`]).toBe(
      guestEntityId,
    );
    // The historical fork, pinned: re-deriving the account hash inside a
    // scenario does NOT reproduce the executor's id. Any scenario that spells
    // the recipe out itself is stamping a stranger.
    expect(stringToUuid(`scenario-account:${scenarioId}:guest`)).not.toBe(
      guestEntityId,
    );
    // The owner's own room stays reachable through the primary alias too.
    expect(seedContext?.primaryUserId).toBe(turnMessages.get("main")?.entityId);
    // `entityIds` is the canonical-alias map and is deliberately NOT the turn
    // identity for a linked account — a seed that scopes rows by it instead of
    // `roomEntityIds` writes where that room's turns can never read.
    expect(seedContext?.entityIds?.owner).not.toBe(
      turnMessages.get("linked")?.entityId,
    );
  });

  it("configures only the owner's linked accounts as canonical owners", async () => {
    const scenarioId = "owner-contact-scoping";
    const turnMessages = new Map<string, Memory>();
    const settings = new Map<string, unknown>();
    const runtime = createIdentityRuntime(
      (roomKey, message) => turnMessages.set(roomKey, message),
      settings,
    );
    let seedContext: ScenarioContext | undefined;

    const report = await runScenario(
      {
        id: scenarioId,
        title: "Owner contact scoping",
        domain: "executor",
        rooms: [
          {
            id: "main",
            account: "owner-chat",
            entity: "owner",
            source: "client_chat",
            title: "Owner",
          },
          {
            // A second connector account for the SAME canonical entity: a
            // verified linked account of the owner (#24842's model), which must
            // stay an owner contact.
            id: "owner-telegram",
            account: "owner-telegram",
            entity: "owner",
            source: "telegram",
            title: "Owner on Telegram",
          },
          {
            // A different principal entirely. Never an owner.
            id: "guest",
            account: `${scenarioId}:guest`,
            entity: "guest",
            source: "client_chat",
            title: "Guest",
          },
        ],
        seed: [
          {
            type: "custom",
            name: "capture published topology",
            apply(ctx) {
              seedContext = ctx;
            },
          },
        ],
        turns: [
          {
            kind: "action",
            name: "guest turn",
            actionName: "IDENTITY_PROBE",
            room: "guest",
            text: "guest speaks",
            options: { roomKey: "guest" },
          },
        ],
      },
      runtime,
      { minJudgeScore: 0.8, providerName: "unit-test", turnTimeoutMs: 1_000 },
    );

    expect(report.status).toBe("passed");

    const contacts = ownerContacts(settings);
    expect(settings.get("ELIZA_ADMIN_ENTITY_ID")).toBe(
      seedContext?.entityIds?.owner,
    );

    // The vacuous-wall regression: the guest must be absent from every id the
    // roles system reads as a configured owner, or an owner-only refusal turn
    // proves nothing.
    const guestEntityId = turnMessages.get("guest")?.entityId;
    const configuredOwnerIds = [
      settings.get("ELIZA_ADMIN_ENTITY_ID"),
      ...Object.values(contacts).map((contact) => contact.entityId),
    ];
    expect(guestEntityId).toBeDefined();
    expect(configuredOwnerIds).not.toContain(guestEntityId);

    // ...while the owner's verified linked account stays one, so #24842's
    // cross-world continuity keeps working.
    expect(Object.keys(contacts).sort()).toEqual([
      "owner-chat",
      "owner-telegram",
    ]);
    expect(contacts["owner-telegram"]?.entityId).toBe(
      seedContext?.roomEntityIds?.["owner-telegram"],
    );
  });
});
