import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalEoaBackend } from "./local-eoa-backend.ts";
import { resolveWalletBackend } from "./select-backend.ts";
import { StewardBackend } from "./steward-backend.ts";

function makeRuntime(settings = {}) {
  return {
    agentId: "agent-1",
    getSetting: (key) => (key in settings ? settings[key] : null),
  };
}

describe("resolveWalletBackend", () => {
  let localSpy;
  let stewardSpy;

  beforeEach(() => {
    localSpy = vi
      .spyOn(LocalEoaBackend, "create")
      .mockResolvedValue({ kind: "local" });
    stewardSpy = vi
      .spyOn(StewardBackend, "create")
      .mockResolvedValue({ kind: "steward" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("honors an explicit local mode", async () => {
    const runtime = makeRuntime({ ELIZA_WALLET_BACKEND: "local" });
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("local");
    expect(localSpy).toHaveBeenCalledWith(runtime);
    expect(stewardSpy).not.toHaveBeenCalled();
  });

  it("honors an explicit steward mode", async () => {
    const runtime = makeRuntime({ ELIZA_WALLET_BACKEND: "steward" });
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("steward");
    expect(stewardSpy).toHaveBeenCalledWith(runtime);
    expect(localSpy).not.toHaveBeenCalled();
  });

  it("falls back to auto (local) on an invalid mode value instead of failing open", async () => {
    const runtime = makeRuntime({ ELIZA_WALLET_BACKEND: "magic-backend" });
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("local");
    expect(stewardSpy).not.toHaveBeenCalled();
  });

  it("auto prefers steward when ELIZA_WALLET_STEWARD_AUTO=1", async () => {
    vi.stubEnv("ELIZA_WALLET_STEWARD_AUTO", "1");
    const runtime = makeRuntime();
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("steward");
    expect(localSpy).not.toHaveBeenCalled();
  });

  it("auto prefers steward when cloud-provisioned", async () => {
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "1");
    const runtime = makeRuntime();
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("steward");
  });

  it("auto does NOT prefer steward when cloud-provisioned is 0", async () => {
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
    const runtime = makeRuntime();
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("local");
    expect(stewardSpy).not.toHaveBeenCalled();
  });

  it("auto defaults to local when no steward preference is signaled", async () => {
    const runtime = makeRuntime();
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("local");
  });

  it("runtime setting wins over process env", async () => {
    vi.stubEnv("ELIZA_WALLET_BACKEND", "local");
    const runtime = makeRuntime({ ELIZA_WALLET_BACKEND: "steward" });
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("steward");
  });

  it("reads the mode from process env when the runtime setting is absent", async () => {
    vi.stubEnv("ELIZA_WALLET_BACKEND", "steward");
    const runtime = makeRuntime();
    const backend = await resolveWalletBackend(runtime);
    expect(backend.kind).toBe("steward");
  });
});
