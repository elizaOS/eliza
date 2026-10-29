import { describe, expect, it, vi } from "vitest";
import {
  createPermissionStepFlow,
  locationAccess,
  permissionStateAccess,
  photoLibraryAccess,
  showWalkthroughCompletion,
  walkthroughMemory,
  walkthroughProgress,
} from "./permission-walkthrough";

const mapStore = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
};

describe("platform access readers", () => {
  it("names partial and selected photo access without claiming the library", () => {
    expect(
      photoLibraryAccess({ scope: "selected", locked: false }),
    ).toMatchObject({
      granted: true,
      description: "Selected photos and videos only",
    });
    expect(
      photoLibraryAccess({ scope: "partial", locked: false }).description,
    ).toBe("Limited photo or video access allowed");
    expect(
      photoLibraryAccess({ scope: "full", locked: false }).description,
    ).toBe("All photos and videos allowed");
    expect(photoLibraryAccess({ scope: "denied", locked: false }).granted).toBe(
      false,
    );
    expect(() => photoLibraryAccess({ scope: "full", locked: true })).toThrow();
    expect(() =>
      photoLibraryAccess({ scope: "everything", locked: false }),
    ).toThrow();
  });
  it("accepts approximate location and refuses inconsistent accuracy", () => {
    expect(
      locationAccess({ location: "granted", accuracy: "approximate" }),
    ).toMatchObject({
      granted: true,
      description: "Approximate location allowed",
    });
    expect(
      locationAccess({ location: "denied", accuracy: "none" }),
    ).toMatchObject({ granted: false, requestable: false });
    expect(
      locationAccess({ location: "prompt", accuracy: "none" }).requestable,
    ).toBe(true);
    expect(() =>
      locationAccess({ location: "granted", accuracy: "none" }),
    ).toThrow();
    expect(() =>
      locationAccess({ location: "denied", accuracy: "precise" }),
    ).toThrow();
    expect(permissionStateAccess("prompt-with-rationale")).toEqual({
      granted: false,
      enabled: false,
      requestable: true,
    });
    expect(() => permissionStateAccess("maybe")).toThrow();
  });
});

describe("step flow", () => {
  it("requests only from an explicit tap and never prompts twice, even after a restart", async () => {
    const store = mapStore();
    const memory = walkthroughMemory(
      "host.walkthrough.v1",
      "host:reopen",
      () => store,
    );
    let granted = false;
    const bridge = {
      status: vi.fn(async () => ({ granted, enabled: granted })),
      request: vi.fn(async () => undefined),
      openSettings: vi.fn(async () => undefined),
    };
    const flow = createPermissionStepFlow(bridge, {
      attemptKey: "camera",
      memory,
    });
    expect(await flow.refresh()).toBe("request");
    expect(bridge.request).not.toHaveBeenCalled();
    expect(await flow.enable()).toBe("settings");
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(memory.read().attempted).toEqual({ camera: true });
    const restarted = createPermissionStepFlow(bridge, {
      attemptKey: "camera",
      memory,
    });
    expect(await restarted.refresh()).toBe("settings");
    expect(await restarted.enable()).toBe("settings");
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(bridge.openSettings).toHaveBeenCalledTimes(1);
    granted = true;
    expect(await restarted.refresh()).toBe("ready");
  });
  it("a denied or unrequestable step goes to settings; a failing bridge is unavailable", async () => {
    const denied = createPermissionStepFlow({
      status: async () => ({
        granted: false,
        enabled: false,
        requestable: false,
      }),
      request: async () => {},
      openSettings: async () => {},
    });
    expect(await denied.refresh()).toBe("settings");
    const broken = createPermissionStepFlow({
      status: async () => {
        throw Error("bridge");
      },
      request: async () => {},
      openSettings: async () => {},
    });
    expect(await broken.refresh()).toBe("unavailable");
    const malformed = createPermissionStepFlow({
      status: async () => ({ granted: "yes" }) as never,
      request: async () => {},
      openSettings: async () => {},
    });
    expect(await malformed.refresh()).toBe("unavailable");
  });
  it("a cancelled prompt cannot advance a later step", async () => {
    let resolve!: () => void;
    const flow = createPermissionStepFlow({
      status: async () => ({ granted: false, enabled: false }),
      request: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
      openSettings: async () => {},
    });
    const tapped = flow.enable();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    expect(await flow.enable()).toBeNull();
    flow.cancel();
    resolve();
    expect(await tapped).toBeNull();
  });
});

describe("memory and reopen", () => {
  it("drops unknown attempt names and survives blocked storage", () => {
    const store = mapStore();
    store.setItem(
      "k",
      JSON.stringify({
        dismissed: true,
        attempted: { camera: true, "bad key": true, mic: "yes" },
      }),
    );
    const memory = walkthroughMemory("k", "e", () => store);
    expect(memory.read()).toEqual({
      dismissed: true,
      attempted: { camera: true },
    });
    const blocked = walkthroughMemory("k", "e", () => ({
      getItem: () => {
        throw Error("blocked");
      },
      setItem: () => {
        throw Error("blocked");
      },
    }));
    expect(blocked.read()).toEqual({ dismissed: false, attempted: {} });
    expect(blocked.write({ dismissed: true })).toBe(false);
  });
  it("reopen clears the dismissal and announces it without requesting anything", () => {
    const store = mapStore();
    const memory = walkthroughMemory("k", "host:reopen", () => store);
    memory.write({ dismissed: true, attempted: { camera: true } });
    const seen = vi.fn();
    globalThis.addEventListener?.("host:reopen", seen);
    memory.reopen();
    globalThis.removeEventListener?.("host:reopen", seen);
    expect(memory.read()).toEqual({
      dismissed: false,
      attempted: { camera: true },
    });
    if (globalThis.addEventListener) expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("resumable progress", () => {
  const progress = walkthroughProgress(
    "host:walkthrough:v1",
    { 1: 4, 2: 5, 3: 6 },
    3,
  );
  it("starts, resumes on the current list and keeps completed runs completed", () => {
    const store = mapStore();
    expect(progress.read(store)).toEqual({
      version: 3,
      status: "pending",
      step: 0,
    });
    store.setItem(
      "host:walkthrough:v1",
      JSON.stringify({ version: 1, status: "pending", step: 2 }),
    );
    expect(progress.read(store)).toEqual({
      version: 3,
      status: "pending",
      step: 2,
    });
    store.setItem(
      "host:walkthrough:v1",
      JSON.stringify({ version: 1, status: "completed", step: 4 }),
    );
    expect(progress.read(store).version).toBe(1);
    progress.write(store, {
      version: 3,
      status: "pending",
      step: 2,
      choices: ["allowed", "skipped"],
    });
    expect(progress.read(store).choices).toEqual(["allowed", "skipped"]);
  });
  it("refuses damaged, out-of-range and unknown-version records", () => {
    const store = mapStore();
    for (const bad of [
      { version: 3, status: "pending", step: 6 },
      { version: 3, status: "completed", step: 5 },
      { version: 9, status: "pending", step: 0 },
      { version: 3, status: "pending", step: 1, choices: [] },
      { version: 3, status: "pending", step: 1, choices: ["granted"] },
      { version: 3, status: "pending", step: 1, extra: true },
    ]) {
      store.setItem("host:walkthrough:v1", JSON.stringify(bad));
      expect(() => progress.read(store)).toThrow(
        "Setup progress is unavailable.",
      );
    }
    expect(() =>
      progress.write(store, { version: 3, status: "pending", step: 7 }),
    ).toThrow();
    expect(() =>
      progress.write(
        { getItem: () => "other", setItem: () => {} },
        { version: 3, status: "pending", step: 0 },
      ),
    ).toThrow("could not be saved");
    expect(() => walkthroughProgress("k", { 1: 4 }, 2)).toThrow();
  });
});

describe("completion popup", () => {
  it("opens only for a newly created account and never over a resumed walkthrough", () => {
    expect(
      showWalkthroughCompletion({ accountCreated: true, resumed: false }),
    ).toBe(true);
    expect(
      showWalkthroughCompletion({ accountCreated: false, resumed: false }),
    ).toBe(false);
    expect(
      showWalkthroughCompletion({ accountCreated: undefined, resumed: false }),
    ).toBe(false);
    expect(
      showWalkthroughCompletion({ accountCreated: true, resumed: true }),
    ).toBe(false);
  });
});
