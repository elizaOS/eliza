// @vitest-environment jsdom

/**
 * Coverage for the local-runtime finish path (`finishLocal`, exercised only
 * via the exported `runFirstRunFinish` router) and the router's own
 * validation/error boundaries. The cloud-runtime paths are covered in
 * `first-run-finish.reused-shared-handoff.test.ts` and
 * `first-run-finish.force-fresh.test.ts`; this file fills in the desktop/web
 * local-runtime branch (non-native, non-Android/iOS, no loopback proxy) that
 * neither of those exercises.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunProfileDraft } from "./first-run";
import type {
  FirstRunFinishDraft,
  FirstRunFinishPorts,
} from "./first-run-finish";
import { runFirstRunFinish } from "./first-run-finish";

const clientMock = vi.hoisted(() => ({
  submitFirstRun: vi.fn(async () => {}),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
  getBaseUrl: vi.fn(() => ""),
  getAuthStatus: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../api", () => ({ client: clientMock }));

vi.mock("../platform/init", () => ({
  isAndroid: false,
  isIOS: false,
  isNative: false,
  isDesktopPlatform: () => false,
}));

vi.mock("./auto-download-recommended", () => ({
  autoDownloadRecommendedLocalModelInBackground: vi.fn(),
}));

vi.mock("./runtime-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-target")>()),
  resolveFirstRunLocalAgentApiBase: () => "",
}));

const savePersistedActiveServerMock = vi.hoisted(() => vi.fn());
const addAgentProfileMock = vi.hoisted(() => vi.fn(() => ({ id: "p1" })));

vi.mock("../state", () => ({
  addAgentProfile: addAgentProfileMock,
  createPersistedActiveServer: vi.fn((v) => v),
  loadPersistedActiveServer: vi.fn(() => null),
  removeAgentProfile: vi.fn(),
  savePersistedActiveServer: savePersistedActiveServerMock,
  savePersistedFirstRunComplete: vi.fn(),
}));

vi.mock("./mobile-runtime-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mobile-runtime-mode")>()),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
}));

function draft(
  overrides: Partial<FirstRunProfileDraft> = {},
): FirstRunFinishDraft {
  return {
    agentName: "Eliza",
    runtime: "local",
    localInference: "all-local",
    remoteApiBase: "",
    remoteToken: "",
    ...overrides,
  } as FirstRunFinishDraft;
}

function ports(): FirstRunFinishPorts {
  return {
    uiLanguage: "en",
    elizaCloudConnected: true,
    handleCloudLogin: vi.fn(async () => {}),
    setRuntimeState: vi.fn(),
    setTab: vi.fn(),
    completeFirstRun: vi.fn(),
    onStatus: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMock.getBaseUrl.mockReturnValue("");
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("runFirstRunFinish — router boundaries", () => {
  it("returns a validation error without touching the client for an invalid draft", async () => {
    const outcome = await runFirstRunFinish(
      // Cast required: `runFirstRunFinish` only accepts the runtimes it
      // actually provisions ("remote" is excluded — see FirstRunFinishDraft),
      // but validateFirstRunSubmitDraft still rejects a malformed remote
      // target as a runtime-agnostic boundary check, which is what this test
      // exercises.
      draft({
        runtime: "remote",
        remoteApiBase: "not a url",
      } as unknown as Partial<FirstRunProfileDraft>),
      ports(),
    );
    expect(outcome.kind).toBe("error");
    expect(clientMock.submitFirstRun).not.toHaveBeenCalled();
  });

  // Must run BEFORE the success test below: `persistFirstRun` in
  // first-run-finish.ts guards its POST with a module-level
  // "already persisted" latch, so once a run succeeds within this module
  // instance, submitFirstRun is never called again — this rejection would go
  // unobserved if it ran second.
  it("translates a thrown error from the runtime path into a structured error outcome (J1 boundary)", async () => {
    clientMock.submitFirstRun.mockRejectedValueOnce(new Error("boom"));
    const p = ports();
    const outcome = await runFirstRunFinish(draft(), p);
    expect(outcome).toEqual({ kind: "error", message: "boom" });
    expect(p.onStatus).toHaveBeenCalledWith(null);
  });
});

describe("runFirstRunFinish — local runtime (desktop/web, non-loopback)", () => {
  it("starts the local runtime, persists the app-shell active server, and completes (#local finish)", async () => {
    const p = ports();
    const outcome = await runFirstRunFinish(draft(), p);
    expect(outcome.kind).toBe("done");
    expect(clientMock.getAuthStatus).toHaveBeenCalled();
    expect(savePersistedActiveServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "local:app-shell", kind: "local" }),
    );
    expect(addAgentProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local" }),
    );
    expect(clientMock.submitFirstRun).toHaveBeenCalledTimes(1);
    expect(p.completeFirstRun).toHaveBeenCalledWith("chat");
  });
});
