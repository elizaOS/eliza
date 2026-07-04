// @vitest-environment jsdom
//
// usePermissionPriming sequencing: mount-time status check skips already-granted
// items, "Enable" fires exactly one OS request (soft-ask), denial keeps the card
// active for recovery, and the sequence advances/completes correctly. The
// permissions client (`getPermission`/`requestPermission`) is mocked; the hook is real.
import type {
  PermissionId,
  PermissionState,
  PermissionStatus,
} from "@elizaos/shared/contracts/permissions";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPermission: vi.fn(),
  requestPermission: vi.fn(),
  openPermissionSettings: vi.fn(async () => undefined),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    client: {
      getPermission: mocks.getPermission,
      requestPermission: mocks.requestPermission,
      openPermissionSettings: mocks.openPermissionSettings,
    },
  };
});

import { usePermissionPriming } from "./use-permission-priming";

function state(
  id: PermissionId,
  status: PermissionStatus,
  canRequest = status === "not-determined",
): PermissionState {
  return { id, status, canRequest, platform: "web", lastChecked: 0 };
}

/** Route getPermission by id from a status map. */
function seedStatuses(map: Partial<Record<PermissionId, PermissionStatus>>) {
  mocks.getPermission.mockImplementation(async (id: PermissionId) =>
    state(id, map[id] ?? "not-determined"),
  );
}

const IDS: PermissionId[] = ["microphone", "location", "notifications"];

afterEach(() => {
  vi.clearAllMocks();
});

describe("usePermissionPriming", () => {
  it("checks on mount without prompting and drops already-granted ids", async () => {
    seedStatuses({
      microphone: "granted",
      location: "not-determined",
      notifications: "granted",
    });

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Mount only checks; it must never request.
    expect(mocks.requestPermission).not.toHaveBeenCalled();
    // Granted ids are excluded; only location remains.
    expect(result.current.items.map((i) => i.id)).toEqual(["location"]);
    expect(result.current.active?.id).toBe("location");
    expect(result.current.totalSteps).toBe(1);
    expect(result.current.done).toBe(false);
  });

  it("is done immediately when everything is already granted", async () => {
    seedStatuses({
      microphone: "granted",
      location: "granted",
      notifications: "granted",
    });
    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.active).toBeNull();
    expect(result.current.done).toBe(true);
  });

  it("fires the OS request only on request(), resolves + advances on grant", async () => {
    seedStatuses({
      microphone: "not-determined",
      location: "not-determined",
      notifications: "not-determined",
    });
    mocks.requestPermission.mockImplementation(async (id: PermissionId) =>
      state(id, "granted", false),
    );

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.active?.id).toBe("microphone");

    await act(async () => {
      await result.current.request("microphone");
    });

    expect(mocks.requestPermission).toHaveBeenCalledWith("microphone");
    // Granted → resolved → advance to the next card.
    expect(result.current.active?.id).toBe("location");
    expect(result.current.currentStep).toBe(2);
  });

  it("keeps a denied card active with a recovery path, then skip advances", async () => {
    seedStatuses({ microphone: "not-determined" });
    mocks.getPermission.mockImplementation(async (id: PermissionId) =>
      state(id, id === "microphone" ? "not-determined" : "granted"),
    );
    mocks.requestPermission.mockResolvedValueOnce(
      state("microphone", "denied", false),
    );

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items.map((i) => i.id)).toEqual(["microphone"]);

    await act(async () => {
      await result.current.request("microphone");
    });

    // Denied does NOT resolve — the card stays active so recovery can show.
    expect(result.current.active?.id).toBe("microphone");
    expect(result.current.active?.status).toBe("denied");
    expect(result.current.active?.canRequest).toBe(false);
    expect(result.current.done).toBe(false);

    act(() => result.current.skip("microphone"));
    expect(result.current.done).toBe(true);
  });

  it("surfaces a thrown request as denied instead of a dead card", async () => {
    seedStatuses({ microphone: "not-determined" });
    mocks.getPermission.mockImplementation(async (id: PermissionId) =>
      state(id, id === "microphone" ? "not-determined" : "granted"),
    );
    mocks.requestPermission.mockRejectedValueOnce(new Error("bridge down"));

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.request("microphone");
    });

    expect(result.current.active?.status).toBe("denied");
    expect(result.current.active?.requesting).toBe(false);
  });

  it("skipAll resolves everything at once", async () => {
    seedStatuses({
      microphone: "not-determined",
      location: "not-determined",
      notifications: "not-determined",
    });
    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.totalSteps).toBe(3);

    act(() => result.current.skipAll());
    expect(result.current.done).toBe(true);
    expect(result.current.active).toBeNull();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });

  it("recheck reflects a permission granted out-of-band (e.g. via Settings)", async () => {
    seedStatuses({ microphone: "denied" });
    mocks.getPermission.mockImplementation(async (id: PermissionId) =>
      state(id, id === "microphone" ? "denied" : "granted"),
    );

    const { result } = renderHook(() => usePermissionPriming(IDS));
    await waitFor(() => expect(result.current.ready).toBe(true));
    // A denied id is still promptable-as-a-card (not satisfied), so it shows.
    expect(result.current.active?.id).toBe("microphone");

    mocks.getPermission.mockImplementation(async (id: PermissionId) =>
      state(id, "granted", false),
    );
    await act(async () => {
      await result.current.recheck("microphone");
    });
    expect(result.current.done).toBe(true);
  });
});
