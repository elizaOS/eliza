// @vitest-environment jsdom
import type { PermissionId } from "@elizaos/core/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativePermissionHostProvider,
  type PermissionPrimingHost,
} from "./native-permission-host";
import { resolvePrimingSet } from "./permission-priming";
import {
  type WalkthroughMemoryStore,
  walkthroughMemory,
} from "./permission-walkthrough";

const registry = {
  check: vi.fn(),
  request: vi.fn(),
};
vi.mock("../../api/client", () => ({
  client: { openPermissionSettings: vi.fn(async () => {}) },
}));
vi.mock("../../platform/init", () => ({
  isNative: false,
  isDesktopPlatform: () => false,
}));
vi.mock("../../platform/desktop-permissions-client", () => ({
  checkDesktopPermissionFresh: vi.fn(),
}));
vi.mock("../../platform/mobile-permissions-client", () => ({
  createMobileSignalsPermissionsRegistry: () => registry,
  openMobilePermissionSettings: vi.fn(async () => {}),
}));
vi.mock("../composites/chat/permission-card.helpers", () => ({
  createClientPermissionsRegistry: () => registry,
}));

const { usePermissionPriming } = await import("./use-permission-priming");

const mapStore = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};
const ids: PermissionId[] = ["microphone", "speech-recognition"];

beforeEach(() => {
  registry.check.mockReset();
  registry.request.mockReset();
  registry.check.mockResolvedValue({
    status: "not-determined",
    canRequest: true,
  });
});

describe("installed permission host", () => {
  function hostFixture(memory?: WalkthroughMemoryStore) {
    const host: PermissionPrimingHost = {
      supported: ["photos", "location"],
      memory,
      registry: {
        check: vi.fn<PermissionPrimingHost["registry"]["check"]>(
          async (id) => ({
            id,
            status: "not-determined",
            canRequest: true,
            platform: "android",
            lastChecked: 0,
          }),
        ),
        request: vi.fn<PermissionPrimingHost["registry"]["request"]>(
          async (id) => ({
            id,
            status: "limited",
            canRequest: false,
            platform: "android",
            lastChecked: 1,
            reason: "Selected photos and videos only",
          }),
        ),
        openSettings: vi.fn(async () => true),
      },
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NativePermissionHostProvider host={host}>
        {children}
      </NativePermissionHostProvider>
    );
    return { host, wrapper };
  }

  it("filters the six Android cards by installed capabilities without prompting on mount", async () => {
    const { host, wrapper } = hostFixture();
    const selected = resolvePrimingSet({
      platform: "android",
      supported: host.supported,
    });
    expect(selected).toEqual(["location", "photos"]);
    const hook = renderHook(() => usePermissionPriming(selected), { wrapper });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(host.registry.request).not.toHaveBeenCalled();
    await act(() => hook.result.current.request("camera"));
    expect(host.registry.request).not.toHaveBeenCalled();
  });

  it("keeps selected-photo and approximate-location scope visible after platform readback", async () => {
    const { host, wrapper } = hostFixture();
    const hook = renderHook(
      () => usePermissionPriming(["photos", "location"]),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(() => hook.result.current.request("photos"));
    expect(hook.result.current.active).toMatchObject({
      id: "photos",
      status: "limited",
      reason: "Selected photos and videos only",
      resolved: false,
    });
    act(() => hook.result.current.skip("photos"));
    vi.mocked(host.registry.request).mockResolvedValueOnce({
      id: "location",
      status: "granted",
      canRequest: false,
      platform: "android",
      lastChecked: 2,
      reason: "Approximate location allowed",
    });
    await act(() => hook.result.current.request("location"));
    expect(hook.result.current.active).toMatchObject({
      status: "granted",
      reason: "Approximate location allowed",
      resolved: false,
    });
    expect(registry.request).not.toHaveBeenCalled();
  });

  it("does not advance a skipped card or a new mount from a late platform answer", async () => {
    const { host, wrapper } = hostFixture();
    let answer!: (
      value: Awaited<ReturnType<typeof host.registry.request>>,
    ) => void;
    vi.mocked(host.registry.request).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const hook = renderHook(
      () => usePermissionPriming(["photos", "location"]),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.request("photos");
    });
    act(() => hook.result.current.skip("photos"));
    hook.unmount();
    const next = renderHook(() => usePermissionPriming(["location"]), {
      wrapper,
    });
    await waitFor(() => expect(next.result.current.ready).toBe(true));
    await act(async () => {
      answer({
        id: "photos",
        status: "granted",
        canRequest: false,
        platform: "android",
        lastChecked: 2,
      });
      await pending;
    });
    expect(next.result.current.active).toMatchObject({
      id: "location",
      status: "not-determined",
      resolved: false,
    });
  });

  it("preserves reviewed choices across restart and clears them only on explicit reopen", async () => {
    const store = mapStore();
    const memory = walkthroughMemory(
      "native-memory",
      "native-reopen",
      () => store,
    );
    const { host, wrapper } = hostFixture(memory);
    const first = renderHook(
      () => usePermissionPriming(["photos", "location"]),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    act(() => first.result.current.skip("photos"));
    first.unmount();
    const second = renderHook(
      () => usePermissionPriming(["photos", "location"]),
      { wrapper },
    );
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(second.result.current.items.map((item) => item.id)).toEqual([
      "location",
    ]);
    second.unmount();
    memory.reopen();
    const third = renderHook(
      () => usePermissionPriming(["photos", "location"]),
      { wrapper },
    );
    await waitFor(() => expect(third.result.current.ready).toBe(true));
    expect(third.result.current.items.map((item) => item.id)).toEqual([
      "photos",
      "location",
    ]);
    expect(host.registry.request).not.toHaveBeenCalled();
  });
});

describe("usePermissionPriming with walkthrough memory", () => {
  it("records a shown prompt and never fires it again after a restart", async () => {
    const store = mapStore();
    const memory = walkthroughMemory("k", "reopen", () => store);
    registry.request.mockResolvedValue({ status: "denied", canRequest: true });
    const first = renderHook(() => usePermissionPriming(ids, { memory }));
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    await act(() => first.result.current.request("speech-recognition"));
    expect(registry.request).toHaveBeenCalledTimes(1);
    expect(memory.read().attempted).toEqual({ speechrecognition: true });
    const denied = first.result.current.items.find(
      (item) => item.id === "speech-recognition",
    );
    expect(denied).toMatchObject({ canRequest: false, promptShown: true });
    first.unmount();

    // Restart: the OS may report "prompt" again, but the walkthrough already asked.
    const second = renderHook(() => usePermissionPriming(ids, { memory }));
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    const resumed = second.result.current.items.find(
      (item) => item.id === "speech-recognition",
    );
    expect(resumed).toMatchObject({ canRequest: false, promptShown: true });
    await act(() => second.result.current.request("speech-recognition"));
    expect(registry.request).toHaveBeenCalledTimes(1);
    // An untouched step still prompts on its tap.
    registry.request.mockResolvedValue({
      status: "granted",
      canRequest: false,
    });
    await act(() => second.result.current.request("microphone"));
    expect(registry.request).toHaveBeenCalledTimes(2);
    expect(second.result.current.items[0]).toMatchObject({
      resolved: true,
      promptShown: false,
    });
  });

  it("keeps retry open when the request fails before the OS answers", async () => {
    const store = mapStore();
    const memory = walkthroughMemory("k", "reopen", () => store);
    registry.request.mockRejectedValueOnce(new Error("bridge"));
    const hook = renderHook(() =>
      usePermissionPriming(["microphone"], { memory }),
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(() => hook.result.current.request("microphone"));
    expect(memory.read().attempted).toEqual({});
    expect(hook.result.current.items[0]).toMatchObject({
      requestError: true,
      canRequest: true,
    });
  });

  it("remembers Skip for now and, without memory, keeps the old retry behaviour", async () => {
    const store = mapStore();
    const memory = walkthroughMemory("k", "reopen", () => store);
    const hook = renderHook(() =>
      usePermissionPriming(["microphone"], { memory }),
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    act(() => hook.result.current.skipAll());
    expect(memory.read().dismissed).toBe(true);
    expect(hook.result.current.done).toBe(true);

    registry.request.mockResolvedValue({ status: "denied", canRequest: true });
    const plain = renderHook(() => usePermissionPriming(["microphone"]));
    await waitFor(() => expect(plain.result.current.ready).toBe(true));
    await act(() => plain.result.current.request("microphone"));
    await act(() => plain.result.current.request("microphone"));
    expect(registry.request).toHaveBeenCalledTimes(2);
    expect(plain.result.current.items[0]).toMatchObject({
      canRequest: true,
      promptShown: false,
    });
  });
});
