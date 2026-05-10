import type { IAgentRuntime } from "@elizaos/core";
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
    const result = await pendingPermissionsProvider.get!(
      runtime,
      {} as never,
      {} as never,
    );
    expect(result.text).toBe("");
  });

  it("emits no text when registry has nothing pending", async () => {
    const runtime = makeRuntime(makeRegistry([]));
    const result = await pendingPermissionsProvider.get!(
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
    const result = await pendingPermissionsProvider.get!(
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
});
