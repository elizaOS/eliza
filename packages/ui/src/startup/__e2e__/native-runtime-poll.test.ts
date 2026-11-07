import { describe, expect, it, vi } from "vitest";
import { createStartupPoll, type PollingBackendDeps } from "../startup-phase-poll";
import type { StartupHostPorts } from "../startup-host-ports";

function fixture() {
  const calls: string[] = [];
  let release!: () => void;
  const admission = new Promise<void>(resolve => { release = resolve; });
  const cancelled = { current: false };
  const run = { current: 1 };
  const ports = {
    platform: { isAndroid: true, isIOS: false, isCapacitorNative: () => true, isElectrobunRuntime: () => false },
    configuration: { supportsFullAppShellRoutes: () => true },
    transport: {
      client: {
        getBaseUrl: () => "eliza-local-agent://ipc",
        hasToken: () => false,
        getAuthStatus: async () => {
          calls.push("probe");
          return { required: true, authenticated: false, bootstrapRequired: true };
        },
      },
      prepareNativeRuntimeForUrl: async () => { calls.push("admit"); await admission; calls.push("retired"); },
      requestAndroidLocalAgentStartForUrl: async () => { calls.push("start"); return true; },
      appendIosBootTrace: () => {},
    },
  } as unknown as StartupHostPorts;
  const deps = {
    firstRunCompletionCommittedRef: { current: false },
    setAuthRequired: vi.fn(), setFirstRunCloudProvisionedContainer: vi.fn(),
    setFirstRunComplete: vi.fn(), setFirstRunLoading: vi.fn(),
  } as unknown as PollingBackendDeps;
  const dispatch = vi.fn();
  const start = () => createStartupPoll(ports).runPollingBackend(
    deps, dispatch, { backendTimeoutMs: 30000, allowLocalOriginRecovery: false } as never,
    null, 1, run, cancelled, { current: null },
  );
  return { calls, release, run, cancelled, dispatch, start };
}

describe("canonical poll admission ordering", () => {
  it("cannot start or accept an old resident's probe before admission retires it", async () => {
    const f = fixture();
    const pending = f.start();
    await Promise.resolve();
    expect(f.calls).toEqual(["admit"]);
    f.release();
    await pending;
    expect(f.calls).toEqual(["admit", "retired", "start", "probe"]);
    expect(f.dispatch).toHaveBeenCalledWith({ type: "BACKEND_REACHED", firstRunComplete: false });
  });
  it("drops a retired startup generation after pending admission resolves", async () => {
    const f = fixture();
    const pending = f.start();
    await Promise.resolve();
    f.run.current++;
    f.release();
    await pending;
    expect(f.calls).toEqual(["admit", "retired"]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
