// @vitest-environment jsdom
//
// Mobile committed-runtime restore: `runRestoringSession` must wait out the
// on-device agent's ~30s cold boot instead of re-onboarding a returning
// cloud-hybrid user (#16065), and must NOT convert a genuine probe fault into
// first-run. Drives the real restore module with only the platform flag, the
// desktop bridge, and the existing-install probe stubbed — the probe-wiring and
// the J1 surface-don't-onboard boundary under test are real.

import { logger } from "@elizaos/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client-types-core";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import { MOBILE_RUNTIME_MODE_STORAGE_KEY } from "../first-run/mobile-runtime-mode";
import type { ExistingFirstRunProbeResult } from "./first-run-bootstrap";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import type { StartupEvent } from "./startup-coordinator";
import {
  type RestoringSessionDeps,
  runRestoringSession,
} from "./startup-phase-restore";

const bridgeMock = vi.hoisted(() => ({
  getBackendStartupTimeoutMs: vi.fn(() => 180_000),
  invokeDesktopBridgeRequestWithTimeout: vi.fn(async () => ({
    status: "timeout" as const,
  })),
  isElectrobunRuntime: vi.fn(() => false),
  scanProviderCredentials: vi.fn(async () => []),
}));

const probeMock = vi.hoisted(() => ({
  detectExistingFirstRunConnection: vi.fn(
    async (): Promise<ExistingFirstRunProbeResult | null> => null,
  ),
}));

vi.mock("../bridge", () => bridgeMock);
vi.mock("./first-run-bootstrap", () => probeMock);
// Force the Android native mobile platform; keep every other platform helper
// real so the restore path behaves exactly as it does on-device.
vi.mock("../platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform")>();
  return { ...actual, isAndroid: true, isIOS: false };
});

const LOCAL_PROBE_RESULT: ExistingFirstRunProbeResult = {
  activeServer: { id: "local", kind: "local", label: "Local Agent" },
  detectedExistingInstall: true,
};

function makeDeps(): RestoringSessionDeps {
  return {
    setStartupError: vi.fn(),
    setAuthRequired: vi.fn(),
    setConnected: vi.fn(),
    setFirstRunOptions: vi.fn(),
    setFirstRunComplete: vi.fn(),
    setFirstRunLoading: vi.fn(),
    firstRunCompletionCommittedRef: { current: false },
    uiLanguage: "en",
  };
}

async function drive(dispatch: (event: StartupEvent) => void): Promise<void> {
  await runRestoringSession(
    makeDeps(),
    dispatch,
    { current: null },
    { current: false },
  );
}

describe("runRestoringSession — mobile committed-runtime existing-install probe", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    clearPersistedActiveServer();
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.clearAllMocks();
    bridgeMock.isElectrobunRuntime.mockReturnValue(false);
    bridgeMock.getBackendStartupTimeoutMs.mockReturnValue(180_000);
    probeMock.detectExistingFirstRunConnection.mockResolvedValue(null);
    // primeAuthStatusProbe fires fire-and-forget; a 503 is discarded by design.
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          json: async () => ({}),
        }) as unknown as Response,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    clearPersistedActiveServer();
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.restoreAllMocks();
  });

  it("probes with wait-for-boot (45s) for a committed cloud-hybrid runtime and restores the on-device agent", async () => {
    localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud-hybrid");
    probeMock.detectExistingFirstRunConnection.mockResolvedValue(
      LOCAL_PROBE_RESULT,
    );
    const dispatch = vi.fn();

    await drive(dispatch);

    // The still-booting on-device agent is waited out, not read as "no install".
    expect(probeMock.detectExistingFirstRunConnection).toHaveBeenCalledWith(
      expect.objectContaining({ waitForBootingAgent: true, timeoutMs: 45_000 }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_RESTORED" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "NO_SESSION" }),
    );
  });

  it("SURFACES a genuine probe fault as a restored install (no re-onboard) instead of onboarding", async () => {
    localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud-hybrid");
    // The committed agent booted but answered with an auth error — a genuine
    // fault the probe rethrows. The J1 boundary must route to restore so the
    // real error surfaces in polling-backend, never re-onboard the set-up user.
    probeMock.detectExistingFirstRunConnection.mockRejectedValue(
      new ApiError({
        kind: "http",
        status: 401,
        path: "/api/first-run/status",
        message: "unauthorized",
      }),
    );
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const dispatch = vi.fn();

    await drive(dispatch);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("existing-install probe failed"),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_RESTORED" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "NO_SESSION" }),
    );
  });

  it("keeps the fast single-shot (no wait) for a fresh install and onboards", async () => {
    // No committed mode persisted → fresh install: the probe is a fast
    // single-shot (no boot wait), and a null result routes to onboarding.
    probeMock.detectExistingFirstRunConnection.mockResolvedValue(null);
    const dispatch = vi.fn();

    await drive(dispatch);

    expect(probeMock.detectExistingFirstRunConnection).toHaveBeenCalledWith(
      expect.objectContaining({ waitForBootingAgent: false, timeoutMs: 3_500 }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NO_SESSION" }),
    );
  });

  it("does not wait for a persisted cloud (non-agent) runtime — no bundled agent to boot", async () => {
    localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");
    const dispatch = vi.fn();

    await drive(dispatch);

    // `cloud` runs no on-device agent, so the probe stays a fast single-shot.
    expect(probeMock.detectExistingFirstRunConnection).toHaveBeenCalledWith(
      expect.objectContaining({ waitForBootingAgent: false }),
    );
  });

  it("restores a persisted on-device record under cloud-hybrid without probing (normalized to the IPC identity)", async () => {
    localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud-hybrid");
    // A committed on-device record IS persisted, so restore skips the probe and
    // reconciles the legacy `kind:"local"` record to the Android IPC identity.
    savePersistedActiveServer({
      id: "local",
      kind: "local",
      label: "Local Agent",
    });
    const dispatch = vi.fn();

    await drive(dispatch);

    expect(probeMock.detectExistingFirstRunConnection).not.toHaveBeenCalled();
    expect(loadPersistedActiveServer()).toEqual(
      expect.objectContaining({ apiBase: "eliza-local-agent://ipc" }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_RESTORED" }),
    );
  });

  it("drops a persisted on-device record + re-onboards when the mode is no longer an on-device runtime", async () => {
    // A stale on-device record with a mode switched to `cloud` must be cleared
    // (reconcile → null) and the user routed back to onboarding.
    localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");
    savePersistedActiveServer({
      id: "local:android",
      kind: "remote",
      label: "On-device agent",
      apiBase: "eliza-local-agent://ipc",
    });
    const dispatch = vi.fn();

    await drive(dispatch);

    expect(loadPersistedActiveServer()).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NO_SESSION" }),
    );
  });

  it("honors a one-shot force-fresh directive: clears the record and re-onboards without probing", async () => {
    localStorage.setItem("elizaos:first-run:force-fresh", "1");
    savePersistedActiveServer({
      id: "local:android",
      kind: "remote",
      label: "On-device agent",
      apiBase: "eliza-local-agent://ipc",
    });
    const dispatch = vi.fn();

    await drive(dispatch);

    expect(probeMock.detectExistingFirstRunConnection).not.toHaveBeenCalled();
    expect(loadPersistedActiveServer()).toBeNull();
    // The directive is consumed (one-shot), so the NEXT launch is normal.
    expect(localStorage.getItem("elizaos:first-run:force-fresh")).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NO_SESSION" }),
    );
  });

  it("re-onboards an unrestorable cloud record (id carries a path, no apiBase to recover from)", async () => {
    // A persisted cloud record whose id is not a recoverable `cloud:<agentId>`
    // and that has no apiBase cannot be restored; the reconcile/canRestore gates
    // clear it and the user re-onboards rather than booting a dead session.
    savePersistedActiveServer({
      id: "cloud:tenant/agent",
      kind: "cloud",
      label: "Eliza Cloud",
    });
    const dispatch = vi.fn();

    await drive(dispatch);

    expect(loadPersistedActiveServer()).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NO_SESSION" }),
    );
  });
});
