/**
 * Unit coverage for the pending-permissions provider and its formatters:
 * formatPendingPermissionLine (denied / not-determined / restricted states with
 * relative timing and last-blocked-feature attribution, including non-finite
 * denied-age fail-closed lines from #18705),
 * buildPendingPermissionsContext (the PENDING PERMISSIONS section, empty when
 * nothing is pending), and pendingPermissionsProvider itself (silent when the
 * permissions registry is absent or empty, populated otherwise, registered at
 * position -5, and retained across narrow planner-context routing).
 * Deterministic: the registry and runtime are in-memory vi fakes.
 */
import {
  AgentRuntime,
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  type Character,
  type IAgentRuntime,
  type Memory,
  selectV5PlannerStateProviderNames,
  type UUID,
} from "@elizaos/core";
import type { IPermissionsRegistry, PermissionState } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildPendingPermissionsContext,
  formatPendingPermissionLine,
  PERMISSIONS_REGISTRY_SERVICE_ID,
  pendingPermissionsProvider,
} from "./pending-permissions-provider";

function makeRegistry(pending: PermissionState[]): IPermissionsRegistry {
  return {
    get: vi.fn(),
    check: vi.fn(),
    request: vi.fn(),
    openSettings: vi.fn(async () => false),
    recordBlock: vi.fn(),
    list: vi.fn(() => pending),
    pending: vi.fn(() => pending),
    subscribe: vi.fn(() => () => {}),
    registerProber: vi.fn(),
  };
}

const OWNER_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const GUEST_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const AGENT_ID = "00000000-0000-4000-8000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000004" as UUID;

function ownerMessage(entityId: UUID = OWNER_ID): Memory {
  return {
    id: "00000000-0000-4000-8000-000000000005" as UUID,
    agentId: AGENT_ID,
    entityId,
    roomId: ROOM_ID,
    content: { text: "Why was reminders blocked?", source: "test" },
  } as Memory;
}

function makeRuntime(registry: IPermissionsRegistry | null): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
    getService: vi.fn((id: string) => {
      if (id === PERMISSIONS_REGISTRY_SERVICE_ID && registry) {
        return { getRegistry: () => registry };
      }
      return null;
    }),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("formatPendingPermissionLine", () => {
  const NOW = 1_700_000_000_000;

  it("formats a denied state with last block feature + relative time", () => {
    expect(
      formatPendingPermissionLine(
        {
          id: "reminders",
          status: "denied",
          lastChecked: NOW,
          canRequest: false,
          platform: "darwin",
          lastBlockedFeature: {
            app: "lifeops",
            action: "reminders.create",
            at: NOW - 2 * 24 * 60 * 60 * 1000,
          },
        },
        NOW,
      ),
    ).toBe("- reminders: denied 2 days ago (lifeops.reminders.create)");
  });

  it("formats a not-determined state without timing", () => {
    expect(
      formatPendingPermissionLine(
        {
          id: "screen-recording",
          status: "not-determined",
          lastChecked: NOW,
          canRequest: true,
          platform: "darwin",
        },
        NOW,
      ),
    ).toBe("- screen-recording: not-determined");
  });

  it("formats a restricted state with reason", () => {
    expect(
      formatPendingPermissionLine(
        {
          id: "health",
          status: "restricted",
          restrictedReason: "entitlement_required",
          lastChecked: NOW,
          canRequest: false,
          platform: "darwin",
        },
        NOW,
      ),
    ).toBe("- health: restricted (entitlement_required)");
  });

  it("omits relative age when lastBlockedFeature.at is non-finite (#18705)", () => {
    const deniedWithAt = (at: number): PermissionState => ({
      id: "reminders",
      status: "denied",
      lastChecked: NOW,
      canRequest: false,
      platform: "darwin",
      lastBlockedFeature: {
        app: "lifeops",
        action: "reminders.create",
        at,
      },
    });

    for (const at of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const line = formatPendingPermissionLine(deniedWithAt(at), NOW);
      expect(line).toBe("- reminders: denied (lifeops.reminders.create)");
      expect(line).not.toMatch(/NaN/i);
    }
  });

  it("omits relative age when the clock argument is non-finite (#18705)", () => {
    const line = formatPendingPermissionLine(
      {
        id: "reminders",
        status: "denied",
        lastChecked: NOW,
        canRequest: false,
        platform: "darwin",
        lastBlockedFeature: {
          app: "lifeops",
          action: "reminders.create",
          at: NOW - 60_000,
        },
      },
      Number.NaN,
    );
    expect(line).toBe("- reminders: denied (lifeops.reminders.create)");
    expect(line).not.toMatch(/NaN/i);
  });

  it("keeps finite minute and hour buckets for denied age", () => {
    expect(
      formatPendingPermissionLine(
        {
          id: "camera",
          status: "denied",
          lastChecked: NOW,
          canRequest: false,
          platform: "darwin",
          lastBlockedFeature: {
            app: "native",
            action: "camera.open",
            at: NOW - 5 * 60_000,
          },
        },
        NOW,
      ),
    ).toBe("- camera: denied 5 minutes ago (native.camera.open)");

    expect(
      formatPendingPermissionLine(
        {
          id: "microphone",
          status: "denied",
          lastChecked: NOW,
          canRequest: false,
          platform: "darwin",
          lastBlockedFeature: {
            app: "native",
            action: "mic.open",
            at: NOW - 3 * 60 * 60_000,
          },
        },
        NOW,
      ),
    ).toBe("- microphone: denied 3 hours ago (native.mic.open)");
  });
});

describe("buildPendingPermissionsContext", () => {
  it("returns an empty string when there are no pending permissions", () => {
    expect(buildPendingPermissionsContext([])).toBe("");
  });

  it("returns a multi-line PENDING PERMISSIONS section", () => {
    const NOW = 1_700_000_000_000;
    const result = buildPendingPermissionsContext(
      [
        {
          id: "reminders",
          status: "denied",
          lastChecked: NOW,
          canRequest: false,
          platform: "darwin",
          lastBlockedFeature: {
            app: "lifeops",
            action: "reminders.create",
            at: NOW - 2 * 24 * 60 * 60 * 1000,
          },
        },
        {
          id: "screen-recording",
          status: "not-determined",
          lastChecked: NOW,
          canRequest: true,
          platform: "darwin",
        },
      ],
      NOW,
    );
    expect(result).toBe(
      "PENDING PERMISSIONS:\n" +
        "- reminders: denied 2 days ago (lifeops.reminders.create)\n" +
        "- screen-recording: not-determined",
    );
  });
});

describe("pendingPermissionsProvider", () => {
  it("emits no text when registry is missing", async () => {
    const runtime = makeRuntime(null);
    const result = await pendingPermissionsProvider.get?.(
      runtime,
      ownerMessage(),
      {} as never,
    );
    expect(result.text).toBe("");
  });

  it("emits no text when registry has nothing pending", async () => {
    const runtime = makeRuntime(makeRegistry([]));
    const result = await pendingPermissionsProvider.get?.(
      runtime,
      ownerMessage(),
      {} as never,
    );
    expect(result.text).toBe("");
  });

  it("fails closed for a direct owner call without audience attestation", async () => {
    const NOW = Date.now();
    const runtime = makeRuntime(
      makeRegistry([
        {
          id: "reminders",
          status: "denied",
          lastChecked: NOW,
          canRequest: false,
          platform: "darwin",
          lastBlockedFeature: {
            app: "lifeops",
            action: "reminders.create",
            at: NOW - 5_000,
          },
        },
      ]),
    );
    const result = await pendingPermissionsProvider.get?.(
      runtime,
      ownerMessage(),
      {} as never,
    );
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("fails closed when invoked directly for a non-owner", async () => {
    const runtime = makeRuntime(
      makeRegistry([
        {
          id: "reminders",
          status: "denied",
          lastChecked: Date.now(),
          canRequest: false,
          platform: "darwin",
        },
      ]),
    );
    const result = await pendingPermissionsProvider.get?.(
      runtime,
      ownerMessage(GUEST_ID),
      {} as never,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("registers at position -5", () => {
    expect(pendingPermissionsProvider.position).toBe(-5);
  });

  it("survives narrow routing after production registration and composes for an attested owner DM", async () => {
    const runtime = new AgentRuntime({
      character: { name: "pending-permission-routing" } as Character,
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
    });
    const turn = {
      ...ownerMessage(),
      agentId: runtime.agentId,
    } as Memory;
    vi.spyOn(runtime, "getRoom").mockResolvedValue({
      id: ROOM_ID,
      agentId: runtime.agentId,
      source: "test",
      type: ChannelType.DM,
    });
    vi.spyOn(runtime, "getParticipantsForRoom").mockResolvedValue([
      OWNER_ID,
      runtime.agentId,
    ]);
    const registry = makeRegistry([
      {
        id: "reminders",
        status: "denied",
        lastChecked: Date.now(),
        canRequest: false,
        platform: "darwin",
        lastBlockedFeature: {
          app: "lifeops",
          action: "reminders.create",
          at: Date.now(),
        },
      },
    ]);
    vi.spyOn(runtime, "getService").mockReturnValue({
      getRegistry: () => registry,
    } as never);
    runtime.registerProvider(pendingPermissionsProvider);

    const materialized = runtime.providers.find(
      (provider) => provider.name === pendingPermissionsProvider.name,
    );
    expect(materialized?.contexts).toEqual(["general"]);
    expect(materialized?.alwaysInResponseState).toBe(true);
    expect(materialized?.disclosureGate).toEqual({
      require: "owner_exclusive",
    });
    const selected = selectV5PlannerStateProviderNames({
      runtime,
      message: turn,
      selectedContexts: ["settings"],
      userRoles: ["OWNER"],
    });
    expect(selected).toContain("elizaPendingPermissions");

    await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);
    const state = await runtime.composeState(turn, selected, true, true);
    expect(state.text).toContain("PENDING PERMISSIONS:");
    expect(state.values.pendingPermissionCount).toBe(1);
    const providerRecord = (
      state.data.providers as Record<
        string,
        { data?: { pendingPermissions?: unknown } }
      >
    ).elizaPendingPermissions;
    expect(providerRecord?.data?.pendingPermissions).toEqual([
      {
        id: "reminders",
        status: "denied",
        feature: "lifeops.reminders.create",
      },
    ]);
  });

  it("omits owner-private text and structured data for guest, shared, and unattested turns", async () => {
    async function composeDenied(params: {
      sender: UUID;
      participants: UUID[];
      attest: boolean;
    }) {
      const runtime = new AgentRuntime({
        character: { name: "pending-permission-privacy" } as Character,
        settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      });
      const turn = {
        ...ownerMessage(params.sender),
        agentId: runtime.agentId,
      } as Memory;
      vi.spyOn(runtime, "getRoom").mockResolvedValue({
        id: ROOM_ID,
        agentId: runtime.agentId,
        source: "test",
        type: ChannelType.DM,
      });
      vi.spyOn(runtime, "getParticipantsForRoom").mockResolvedValue([
        ...params.participants,
        runtime.agentId,
      ]);
      vi.spyOn(runtime, "getService").mockReturnValue({
        getRegistry: () =>
          makeRegistry([
            {
              id: "reminders",
              status: "denied",
              lastChecked: Date.now(),
              canRequest: false,
              platform: "darwin",
              lastBlockedFeature: {
                app: "private-canary-app",
                action: "private-canary-action",
                at: Date.now(),
              },
            },
          ]),
      } as never);
      runtime.registerProvider(pendingPermissionsProvider);
      const selected = selectV5PlannerStateProviderNames({
        runtime,
        message: turn,
        selectedContexts: ["settings"],
        userRoles: [params.sender === OWNER_ID ? "OWNER" : "GUEST"],
      });
      if (params.attest) {
        await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);
      }
      return runtime.composeState(turn, selected, true, true);
    }

    const states = await Promise.all([
      composeDenied({
        sender: GUEST_ID,
        participants: [GUEST_ID],
        attest: true,
      }),
      composeDenied({
        sender: OWNER_ID,
        participants: [OWNER_ID, GUEST_ID],
        attest: true,
      }),
      composeDenied({
        sender: OWNER_ID,
        participants: [OWNER_ID],
        attest: false,
      }),
    ]);
    for (const state of states) {
      expect(state.text).not.toContain("PENDING PERMISSIONS:");
      expect(state.text).not.toContain("private-canary-app");
      expect(state.values.pendingPermissionCount).toBeUndefined();
      expect(
        (state.data.providers as Record<string, unknown> | undefined)
          ?.elizaPendingPermissions,
      ).toBeUndefined();
    }
  });
});
