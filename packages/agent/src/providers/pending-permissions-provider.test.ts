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
  type IAgentRuntime,
  selectV5PlannerStateProviderNames,
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

function makeRuntime(registry: IPermissionsRegistry | null): IAgentRuntime {
  return {
    getService: vi.fn((id: string) => {
      if (id === PERMISSIONS_REGISTRY_SERVICE_ID && registry) {
        return { getRegistry: () => registry };
      }
      return null;
    }),
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
      {} as never,
      {} as never,
    );
    expect(result.text).toBe("");
  });

  it("emits no text when registry has nothing pending", async () => {
    const runtime = makeRuntime(makeRegistry([]));
    const result = await pendingPermissionsProvider.get?.(
      runtime,
      {} as never,
      {} as never,
    );
    expect(result.text).toBe("");
  });

  it("emits a populated section when registry returns pending state", async () => {
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
      {} as never,
      {} as never,
    );
    expect(result.text).toContain("PENDING PERMISSIONS:");
    expect(result.text).toContain("reminders: denied");
    expect(result.values?.pendingPermissionCount).toBe(1);
  });

  it("registers at position -5", () => {
    expect(pendingPermissionsProvider.position).toBe(-5);
  });

  it("opts into response-state composition across narrow planner contexts", () => {
    expect(pendingPermissionsProvider.alwaysInResponseState).toBe(true);
    for (const selectedContexts of [["settings"], ["tasks"], ["code"], []]) {
      const selected = selectV5PlannerStateProviderNames({
        runtime: {
          providers: [pendingPermissionsProvider],
        } as unknown as IAgentRuntime,
        message: {
          id: "00000000-0000-0000-0000-000000000001",
          entityId: "00000000-0000-0000-0000-000000000002",
          roomId: "00000000-0000-0000-0000-000000000003",
          content: { text: "Why was reminders blocked?" },
        } as never,
        selectedContexts: selectedContexts as never,
        userRoles: ["MEMBER"],
      });
      expect(selected).toContain("elizaPendingPermissions");
    }
  });
});
