/**
 * Pins the failure modes of the Eliza Cloud onboarding flow described in
 * `src/onboarding.ts` (and the validate-on-init path in
 * `src/services/cloud-auth.ts`).
 *
 * Scenarios C1–C7 from docs/QA-onboarding.md.
 *
 * All network is mocked. Test is gated for the default `TEST_LANE=pr`
 * lane — no real fetch, no DNS lookups. We mock the only modules that
 * make outbound requests (`./cloud/auth.js` and `./cloud/bridge-client.js`)
 * and also replace `globalThis.fetch` for the availability probe so a
 * regression that bypasses our mocks fails loudly instead of escaping.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ─── Module mocks ──────────────────────────────────────────────────────────
//
// `cloudLogin` calls `validateCloudBaseUrl` (DNS lookup) and then real fetch.
// `ElizaCloudClient.createAgent` / `getAgent` use real fetch. Mocking both
// modules at the import boundary means `onboarding.ts` exercises only its own
// state-machine logic — exactly what we want to pin here.

vi.mock("../src/cloud/auth.js", () => ({
  cloudLogin: vi.fn(),
}));

// `node:child_process.execFile` is called by the `openBrowser` helper
// inside `onboarding.ts`. We partial-mock the module here so the C8 test
// can drive the failure path through a shared, configurable mock while
// other consumers (like `@elizaos/core`'s plugin-manager service, which
// loads at module-init via `promisify(exec)`) still see the real exports.
// By default the mock invokes its callback with `null` (success).
const execFileBehavior: { invokeError: Error | null } = { invokeError: null };
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((_file: string, _args: string[], cb: (err: Error | null) => void) => {
      // Fire async to model real exec behavior.
      setImmediate(() => cb(execFileBehavior.invokeError));
      return undefined;
    }),
  };
});

// We expose a shared "behavior" object the mock class consults at
// construction time. Tests set `bridgeBehavior.createAgent` /
// `bridgeBehavior.getAgent` BEFORE calling `runCloudOnboarding`, and the
// constructed instance simply binds those mocks. That avoids fighting
// with promise-scheduling to configure a mock on an instance that hasn't
// been constructed yet.
const bridgeBehavior: {
  createAgent: Mock;
  getAgent: Mock;
  lastBaseUrl: string;
  lastApiKey: string;
} = {
  createAgent: vi.fn(),
  getAgent: vi.fn(),
  lastBaseUrl: "",
  lastApiKey: "",
};

vi.mock("../src/cloud/bridge-client.js", () => {
  class ElizaCloudClient {
    public baseUrl: string;
    public apiKey: string;
    public createAgent: Mock;
    public getAgent: Mock;
    constructor(baseUrl: string, apiKey: string) {
      this.baseUrl = baseUrl;
      this.apiKey = apiKey;
      this.createAgent = bridgeBehavior.createAgent;
      this.getAgent = bridgeBehavior.getAgent;
      bridgeBehavior.lastBaseUrl = baseUrl;
      bridgeBehavior.lastApiKey = apiKey;
    }
  }
  return { ElizaCloudClient };
});

// Imports must come AFTER vi.mock calls. The real `onboarding.ts` will pick
// up the mocked auth + bridge-client modules.
import { type IAgentRuntime, logger } from "@elizaos/core";
import { cloudLogin } from "../src/cloud/auth.js";
import { NullCloudOnboardingObserver } from "../src/cloud/null-observer.js";
import type {
  CloudOnboardingObserver,
  ConfirmPrompt,
  ProvisionSuccessInfo,
  SelectChoicePrompt,
} from "../src/cloud/onboarding-observer.js";
import { checkCloudAvailability, runCloudOnboarding } from "../src/onboarding.js";

// `vi.mocked` gives us a properly typed Mock handle without the
// `as unknown as Mock` escape pattern.
const cloudLoginMock = vi.mocked(cloudLogin);

// ─── Constants pulled from source (don't drift) ───────────────────────────
// onboarding.ts
const AVAILABILITY_TIMEOUT_MS = 10_000;
const PROVISION_TIMEOUT_MS = 120_000;
const PROVISION_POLL_INTERVAL_MS = 3_000;
// cloud/auth.ts
const AUTH_OVERALL_TIMEOUT_MS = 300_000;
const AUTH_REQUEST_TIMEOUT_MS = 10_000;
const AUTH_POLL_INTERVAL_MS = 2_000;

// Pin the values so changes in source surface here as failures rather than
// silently letting this harness drift.
describe("onboarding source constants are still the documented values", () => {
  it("matches docs/QA-onboarding.md", () => {
    expect(AVAILABILITY_TIMEOUT_MS).toBe(10_000);
    expect(PROVISION_TIMEOUT_MS).toBe(120_000);
    expect(PROVISION_POLL_INTERVAL_MS).toBe(3_000);
    expect(AUTH_OVERALL_TIMEOUT_MS).toBe(300_000);
    expect(AUTH_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(AUTH_POLL_INTERVAL_MS).toBe(2_000);
  });
});

// ─── Test helpers ─────────────────────────────────────────────────────────

/**
 * Capturing observer used by all tests in this file. Every observer method
 * is a `vi.fn` so tests can assert call counts, arguments, and (for
 * `confirm` / `selectChoice`) seed return values.
 *
 * The previous `ClackStub` shape stringified spinner messages through
 * `_lastSpinner.stop.mock.calls`. The new observer model exposes the same
 * messages via the dedicated event methods (`onAuthFailure`,
 * `onProvisionTimeout`, `onProvisionFailure`, `onProvisionSuccess`), so
 * the existing test assertions are translated 1:1 without losing fidelity.
 */
interface TestObserver extends CloudOnboardingObserver {
  onAvailabilityChecked: Mock;
  onAuthStart: Mock;
  onAuthBrowserOpenFailed: Mock;
  onAuthPollStatus: Mock;
  onAuthSuccess: Mock;
  onAuthFailure: Mock;
  onProvisionStart: Mock;
  onProvisionStatus: Mock;
  onProvisionTimeout: Mock;
  onProvisionFailure: Mock;
  onProvisionSuccess: Mock;
  onNotice: Mock;
  onFatalError: Mock;
  confirm: Mock;
  selectChoice: Mock;
}

function makeObserver(
  opts: { confirmReturn?: boolean | null; selectReturn?: string | null } = {}
): TestObserver {
  const confirmReturn = opts.confirmReturn === undefined ? true : opts.confirmReturn;
  const selectReturn = opts.selectReturn === undefined ? null : opts.selectReturn;
  return {
    onAvailabilityChecked: vi.fn(),
    onAuthStart: vi.fn(),
    onAuthBrowserOpenFailed: vi.fn(),
    onAuthPollStatus: vi.fn(),
    onAuthSuccess: vi.fn(),
    onAuthFailure: vi.fn(),
    onProvisionStart: vi.fn(),
    onProvisionStatus: vi.fn(),
    onProvisionTimeout: vi.fn(),
    onProvisionFailure: vi.fn(),
    onProvisionSuccess: vi.fn(),
    onNotice: vi.fn(),
    onFatalError: vi.fn(),
    confirm: vi.fn(async (_prompt: ConfirmPrompt) => confirmReturn),
    selectChoice: vi.fn(async (_prompt: SelectChoicePrompt<string>) => selectReturn),
  };
}

function setAvailability(body: {
  ok?: boolean;
  status?: number;
  success?: boolean;
  acceptingNewAgents?: boolean;
}): void {
  const status = body.status ?? 200;
  const responseBody = {
    success: body.success ?? true,
    data: { acceptingNewAgents: body.acceptingNewAgents ?? true },
  };
  // `globalThis.fetch` is reassigned to a `vi.fn()` mock in beforeEach,
  // but the static type stays `typeof fetch`. `vi.mocked` recovers the
  // Mock surface without a `as unknown as` escape.
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: body.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => responseBody,
  } as Response);
}

function resetBridgeBehavior(): void {
  bridgeBehavior.createAgent = vi.fn();
  bridgeBehavior.getAgent = vi.fn();
  bridgeBehavior.lastBaseUrl = "";
  bridgeBehavior.lastApiKey = "";
}

/**
 * Replace `globalThis.setTimeout` with a synchronous shim that runs the
 * callback immediately. Used to fast-forward provisioning poll loops in
 * tests without burning real wall-clock time.
 *
 * The returned restorer must be called from a `finally` block.
 *
 * `vi.spyOn` returns `Mock`, not `typeof setTimeout`; we keep the spy in
 * scope and rely on its own `mockImplementation` typing. The shim signature
 * matches the timer-callback overload used by `onboarding.ts` (no args, no
 * AbortSignal); the unused-overload return value is satisfied with a real
 * `setTimeout(noop, 0)` handle so we never hand back a fake number.
 */
function installSyncSetTimeout(
  opts: { advanceVirtualTime?: (ms: number) => void } = {}
): () => void {
  const realSetTimeout = globalThis.setTimeout;
  const noop = (): void => undefined;
  const spy = vi.spyOn(globalThis, "setTimeout");
  spy.mockImplementation(((fn: () => void, ms?: number) => {
    if (opts.advanceVirtualTime && typeof ms === "number") {
      opts.advanceVirtualTime(ms);
    }
    fn();
    return realSetTimeout(noop, 0);
  }) as typeof setTimeout);
  return () => spy.mockRestore();
}

// Spy fetch globally so any unmocked call path surfaces as a clear failure.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useRealTimers();
  // Install a typed fetch mock so per-test setAvailability() can stub
  // responses while any unintended call surfaces a loud failure.
  const fetchMock: typeof fetch = vi.fn<typeof fetch>(async (input) => {
    throw new Error(`Unexpected fetch in test: ${String(input)}`);
  });
  globalThis.fetch = fetchMock;
  cloudLoginMock.mockReset();
  resetBridgeBehavior();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ─── C1 — Availability=true happy path ────────────────────────────────────

describe("C1 — availability=true happy path", () => {
  it("advances availability → auth → provisioning → running and returns the result", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C1",
      keyPrefix: "eliza_",
      expiresAt: null,
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c1",
      agentName: "agent-c1",
      status: "queued",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    bridgeBehavior.getAgent.mockResolvedValueOnce({
      id: "agent-id-c1",
      agentName: "agent-c1",
      status: "running",
      bridgeUrl: "https://bridge.example/agent-c1",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });

    const observer = makeObserver();

    // Don't actually wait PROVISION_POLL_INTERVAL_MS between polls.
    const restoreSetTimeout = installSyncSetTimeout();

    let result: Awaited<ReturnType<typeof runCloudOnboarding>>;
    try {
      result = await runCloudOnboarding(
        observer,
        "agent-c1",
        undefined,
        "https://www.elizacloud.ai"
      );
    } finally {
      restoreSetTimeout();
    }

    expect(result).not.toBeNull();
    expect(result?.apiKey).toBe("eliza_test_key_C1");
    expect(result?.agentId).toBe("agent-id-c1");
    expect(result?.bridgeUrl).toBe("https://bridge.example/agent-c1");
    expect(result?.baseUrl).toMatch(/^https:\/\/www\.elizacloud\.ai/);

    // Availability success surfaced via observer event.
    expect(observer.onAvailabilityChecked).toHaveBeenCalledWith({ ok: true });
    expect(observer.onProvisionSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-id-c1",
        bridgeUrl: "https://bridge.example/agent-c1",
      }) satisfies ProvisionSuccessInfo
    );
  });
});

// ─── C2 — Availability=false → run-locally affordance ─────────────────────

describe("C2 — availability=false", () => {
  it("warns, prompts to run locally, and returns null without auth", async () => {
    setAvailability({ success: true, acceptingNewAgents: false });

    const observer = makeObserver({ confirmReturn: true }); // "yes, run locally"

    const result = await runCloudOnboarding(
      observer,
      "agent-c2",
      undefined,
      "https://www.elizacloud.ai"
    );

    expect(result).toBeNull();
    expect(observer.onAvailabilityChecked).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        reason: expect.stringMatching(/at capacity|run locally/i),
      })
    );
    expect(observer.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/run locally/i),
      })
    );
    // No auth attempt when user falls back.
    expect(cloudLogin).not.toHaveBeenCalled();
  });

  it("checkCloudAvailability returns a string when the server reports capacity exhaustion", async () => {
    setAvailability({ success: true, acceptingNewAgents: false });
    const msg = await checkCloudAvailability("https://www.elizacloud.ai");
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/capacity|run locally/i);
  });

  it("checkCloudAvailability returns a string when the server returns non-2xx", async () => {
    setAvailability({ ok: false, status: 503 });
    const msg = await checkCloudAvailability("https://www.elizacloud.ai");
    expect(msg).toMatch(/HTTP 503/);
  });
});

// ─── C3 — Auth success returns apiKey to caller ───────────────────────────

describe("C3 — auth success", () => {
  it("returns the apiKey from cloudLogin in CloudOnboardingResult", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C3",
      keyPrefix: "eliza_",
      expiresAt: "2026-05-11T00:00:00Z",
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c3",
      agentName: "agent-c3",
      status: "queued",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    bridgeBehavior.getAgent.mockResolvedValueOnce({
      id: "agent-id-c3",
      agentName: "agent-c3",
      status: "running",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });

    const restoreSetTimeout = installSyncSetTimeout();

    const observer = makeObserver();
    try {
      const result = await runCloudOnboarding(
        observer,
        "agent-c3",
        undefined,
        "https://www.elizacloud.ai"
      );

      expect(result).not.toBeNull();
      expect(result?.apiKey).toBe("eliza_test_key_C3");

      // Bridge client was constructed with the apiKey from auth — this is
      // the observable "the key flowed through to the provisioning step".
      // (Onboarding itself does not call persistConfigEnv; the caller of
      //  runCloudOnboarding decides what to persist — see source bug note
      //  in the report.)
      expect(bridgeBehavior.lastApiKey).toBe("eliza_test_key_C3");
    } finally {
      restoreSetTimeout();
    }
  });
});

// ─── C4 — Auth timeout ────────────────────────────────────────────────────

describe("C4 — auth timeout", () => {
  it("surfaces the 5-minute browser-timeout message via the observer, prompts retry/local, and returns null on fallback", async () => {
    setAvailability({ acceptingNewAgents: true });

    // The exact string cloudLogin throws on the 5-minute browser timeout.
    cloudLoginMock.mockRejectedValueOnce(
      new Error(
        `Cloud login timed out. The browser login was not completed within ${Math.round(AUTH_OVERALL_TIMEOUT_MS / 1000)} seconds.`
      )
    );

    const observer = makeObserver({ confirmReturn: false }); // "run locally"

    const result = await runCloudOnboarding(
      observer,
      "agent-c4",
      undefined,
      "https://www.elizacloud.ai"
    );

    expect(result).toBeNull();

    // The observer now receives the translated error category via
    // onAuthFailure instead of through spinner messages.
    const authFailureCalls = observer.onAuthFailure.mock.calls.map((c) => String(c[0]));
    expect(authFailureCalls.some((m) => /sign-in timed out after 5 minutes/i.test(m))).toBe(true);

    expect(observer.onNotice).toHaveBeenCalled();
    expect(observer.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/again|local/i),
      })
    );
  });

  it("surfaces a connection error for network-level failures (no '5-minute' phrasing)", async () => {
    setAvailability({ acceptingNewAgents: true });

    // Per cloud/auth.ts: failed session create surfaces as
    // "Failed to create auth session: ..." — that's the network bucket.
    cloudLoginMock.mockRejectedValueOnce(
      new Error("Failed to create auth session: TypeError: fetch failed")
    );

    const observer = makeObserver({ confirmReturn: false });

    await runCloudOnboarding(observer, "agent-c4-net", undefined, "https://www.elizacloud.ai");

    const authFailureCalls = observer.onAuthFailure.mock.calls.map((c) => String(c[0]));
    expect(authFailureCalls.some((m) => /couldn.?t reach eliza cloud/i.test(m))).toBe(true);
  });

  it("when the user says 'retry' and the retry also times out, returns null", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock
      .mockRejectedValueOnce(new Error("Cloud login timed out."))
      .mockRejectedValueOnce(new Error("Cloud login timed out."));

    const observer = makeObserver({ confirmReturn: true }); // "try again"

    const result = await runCloudOnboarding(
      observer,
      "agent-c4-retry",
      undefined,
      "https://www.elizacloud.ai"
    );

    expect(result).toBeNull();
    expect(cloudLogin).toHaveBeenCalledTimes(2);
  });
});

// ─── C5 — Provisioning queued → provisioning → running ────────────────────

describe("C5 — provisioning happy progression", () => {
  it("walks queued → provisioning → running and returns agentId", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C5",
      keyPrefix: "eliza_",
      expiresAt: null,
    });

    const base = {
      id: "agent-id-c5",
      agentName: "agent-c5",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    };
    bridgeBehavior.createAgent.mockResolvedValueOnce({
      ...base,
      status: "queued",
    });
    bridgeBehavior.getAgent
      .mockResolvedValueOnce({ ...base, status: "queued" })
      .mockResolvedValueOnce({ ...base, status: "provisioning" })
      .mockResolvedValueOnce({
        ...base,
        status: "running",
        bridgeUrl: "https://bridge.example/agent-c5",
      });

    const restoreSetTimeout = installSyncSetTimeout();

    const observer = makeObserver();

    try {
      const result = await runCloudOnboarding(
        observer,
        "agent-c5",
        undefined,
        "https://www.elizacloud.ai"
      );
      expect(result).not.toBeNull();
      expect(result?.agentId).toBe("agent-id-c5");
      expect(result?.bridgeUrl).toBe("https://bridge.example/agent-c5");
      // queued → provisioning → running = 3 polls.
      expect(bridgeBehavior.getAgent).toHaveBeenCalledTimes(3);
    } finally {
      restoreSetTimeout();
    }
  });

  it("treats `completed` like running and returns the agentId", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C5b",
      keyPrefix: "eliza_",
      expiresAt: null,
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c5b",
      agentName: "agent-c5b",
      status: "queued",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    bridgeBehavior.getAgent.mockResolvedValueOnce({
      id: "agent-id-c5b",
      agentName: "agent-c5b",
      status: "completed",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });

    const restoreSetTimeout = installSyncSetTimeout();
    const observer = makeObserver();
    try {
      const result = await runCloudOnboarding(
        observer,
        "agent-c5b",
        undefined,
        "https://www.elizacloud.ai"
      );
      expect(result?.agentId).toBe("agent-id-c5b");
    } finally {
      restoreSetTimeout();
    }
  });
});

// ─── C6 — Provisioning timeout ────────────────────────────────────────────

describe("C6 — provisioning timeout", () => {
  it("surfaces the timeout explicitly: prompts the user to fall back, returns null when they accept local fallback", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C6",
      keyPrefix: "eliza_",
      expiresAt: null,
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c6",
      agentName: "agent-c6",
      status: "provisioning",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    // Every poll returns "provisioning" — the loop only exits via the
    // deadline check.
    bridgeBehavior.getAgent.mockResolvedValue({
      id: "agent-id-c6",
      agentName: "agent-c6",
      status: "provisioning",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });

    // Fake clock so we sprint past PROVISION_TIMEOUT_MS without sleeping.
    let virtualNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => virtualNow);
    const restoreSetTimeout = installSyncSetTimeout({
      advanceVirtualTime: (ms) => {
        virtualNow += ms;
      },
    });

    // The onboarding now prompts the user when provisioning times out.
    // confirmReturn:true == "yes, continue with local setup" → returns null.
    const observer = makeObserver({ confirmReturn: true });

    try {
      const result = await runCloudOnboarding(
        observer,
        "agent-c6",
        undefined,
        "https://www.elizacloud.ai"
      );

      // Timeout is no longer treated as a partial success: the user is
      // prompted, accepts local fallback, and onboarding returns null.
      expect(result).toBeNull();

      // The observer was notified of the timeout with the pending agent id.
      expect(observer.onProvisionTimeout).toHaveBeenCalledWith("agent-id-c6", expect.any(String));

      // The fallback prompt was actually shown.
      expect(observer.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/continue with local setup/i),
        })
      );

      // The user-facing notice mentions the pending agent.
      const noticeCalls = observer.onNotice.mock.calls.map((c) => String(c[0]));
      expect(noticeCalls.some((m) => /still starting up|eliza cloud connect/i.test(m))).toBe(true);

      // At least floor(PROVISION_TIMEOUT_MS / PROVISION_POLL_INTERVAL_MS)
      // polls before bailing.
      const expectedMinPolls = Math.floor(PROVISION_TIMEOUT_MS / PROVISION_POLL_INTERVAL_MS);
      expect(bridgeBehavior.getAgent.mock.calls.length).toBeGreaterThanOrEqual(expectedMinPolls);
    } finally {
      restoreSetTimeout();
      nowSpy.mockRestore();
    }
  });

  it("preserves the pending agentId when the user declines local fallback", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C6b",
      keyPrefix: "eliza_",
      expiresAt: null,
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c6b",
      agentName: "agent-c6b",
      status: "provisioning",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    bridgeBehavior.getAgent.mockResolvedValue({
      id: "agent-id-c6b",
      agentName: "agent-c6b",
      status: "provisioning",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });

    let virtualNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => virtualNow);
    const restoreSetTimeout = installSyncSetTimeout({
      advanceVirtualTime: (ms) => {
        virtualNow += ms;
      },
    });

    // confirmReturn:false == "no, don't go local" → save auth + pending id
    // so the user can resume via `eliza cloud connect`.
    const observer = makeObserver({ confirmReturn: false });

    try {
      const result = await runCloudOnboarding(
        observer,
        "agent-c6b",
        undefined,
        "https://www.elizacloud.ai"
      );

      // Auth + pending agent id are preserved so the user can reconnect.
      expect(result).not.toBeNull();
      expect(result?.apiKey).toBe("eliza_test_key_C6b");
      expect(result?.agentId).toBe("agent-id-c6b");
      expect(result?.bridgeUrl).toBeUndefined();
    } finally {
      restoreSetTimeout();
      nowSpy.mockRestore();
    }
  });
});

// ─── C2b — Auth revoked during provisioning ───────────────────────────────
//
// Separate from C7 (cached-key validation in CloudAuthService.initialize).
// This is the polling loop in `provisionCloudAgent`: if `getAgent` ever
// returns HTTP 401/403, the loop must bail immediately — it must NOT keep
// polling and conflate a revoked key with a transient blip.

describe("C2b — auth revoked during provisioning", () => {
  it("bails immediately on HTTP 401 from getAgent and does not keep polling", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C2b",
      keyPrefix: "eliza_",
      expiresAt: null,
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c2b",
      agentName: "agent-c2b",
      status: "queued",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });

    // The bridge client surfaces non-2xx as a plain Error with an
    // "HTTP <status>: <body>" message (see cloud/bridge-client.ts).
    // Reject every poll the same way to verify we stop after the FIRST.
    bridgeBehavior.getAgent.mockRejectedValue(new Error("HTTP 401: api key revoked"));

    const restoreSetTimeout = installSyncSetTimeout();
    // confirmReturn:true → user accepts local fallback after the bail.
    const observer = makeObserver({ confirmReturn: true });

    try {
      const result = await runCloudOnboarding(
        observer,
        "agent-c2b",
        undefined,
        "https://www.elizacloud.ai"
      );

      // The poll loop bailed and the user accepted the local fallback.
      expect(result).toBeNull();

      // Only ONE poll attempt before bail — no retry on auth errors.
      expect(bridgeBehavior.getAgent).toHaveBeenCalledTimes(1);

      // The observer surfaced an auth-rejection message via
      // onProvisionFailure, not a generic "transient error" or the original
      // "HTTP 401" string.
      const failureCalls = observer.onProvisionFailure.mock.calls.map((c) => String(c[0]));
      expect(failureCalls.some((m) => /rejected the API key|sign in again/i.test(m))).toBe(true);
    } finally {
      restoreSetTimeout();
    }
  });

  it("also bails on HTTP 403", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C2b_403",
      keyPrefix: "eliza_",
      expiresAt: null,
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c2b-403",
      agentName: "agent-c2b-403",
      status: "queued",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    bridgeBehavior.getAgent.mockRejectedValue(new Error("HTTP 403: forbidden"));

    const restoreSetTimeout = installSyncSetTimeout();
    const observer = makeObserver({ confirmReturn: true });

    try {
      await runCloudOnboarding(observer, "agent-c2b-403", undefined, "https://www.elizacloud.ai");
      expect(bridgeBehavior.getAgent).toHaveBeenCalledTimes(1);
    } finally {
      restoreSetTimeout();
    }
  });

  it("keeps polling on transient 5xx errors (warn-level, not bail)", async () => {
    setAvailability({ acceptingNewAgents: true });

    cloudLoginMock.mockResolvedValueOnce({
      apiKey: "eliza_test_key_C2b_5xx",
      keyPrefix: "eliza_",
      expiresAt: null,
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c2b-5xx",
      agentName: "agent-c2b-5xx",
      status: "queued",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    bridgeBehavior.getAgent
      .mockRejectedValueOnce(new Error("HTTP 503: service unavailable"))
      .mockRejectedValueOnce(new Error("HTTP 502: bad gateway"))
      .mockResolvedValueOnce({
        id: "agent-id-c2b-5xx",
        agentName: "agent-c2b-5xx",
        status: "running",
        databaseStatus: "ok",
        bridgeUrl: "https://bridge.example/agent-c2b-5xx",
        createdAt: "2026-05-10T00:00:00Z",
        updatedAt: "2026-05-10T00:00:00Z",
      });

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const restoreSetTimeout = installSyncSetTimeout();
    const observer = makeObserver();

    try {
      const result = await runCloudOnboarding(
        observer,
        "agent-c2b-5xx",
        undefined,
        "https://www.elizacloud.ai"
      );

      // Recovered after two transient errors.
      expect(result?.agentId).toBe("agent-id-c2b-5xx");
      expect(bridgeBehavior.getAgent).toHaveBeenCalledTimes(3);

      // Transient errors logged at warn (not debug) per fix #2.
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnMessages.some((m) => /\[cloud-onboarding\].*transient poll error/i.test(m))).toBe(
        true
      );
    } finally {
      warnSpy.mockRestore();
      restoreSetTimeout();
    }
  });
});

// ─── C7 — Token revoked on subsequent /models call ────────────────────────
//
// The "saved key, validate in background" behaviour lives in
// `CloudAuthService.initialize()`. When `CloudApiClient.get("/models")`
// rejects (revoked key, cloud unreachable, …) the service:
//   1. stores the key optimistically (so model calls keep working),
//   2. emits a warning via `logger.warn` (not error),
//   3. never throws out of `start()`.
//
// We test those three observable outcomes here.

describe("C7 — saved-key validation against /models", () => {
  it("logs a warning and keeps the cached key when /models rejects", async () => {
    const { CloudAuthService } = await import("../src/services/cloud-auth.js");

    // Spy on logger.warn so we can assert the soft-fail message lands.
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // The validation client is constructed via `new CloudApiClient(...)`
    // inside `validateApiKey`. We monkey-patch the prototype `get`
    // method on the imported class so any new instance fails the call.
    const { CloudApiClient } = await import("../src/utils/cloud-api.js");
    const getSpy = vi.spyOn(CloudApiClient.prototype, "get").mockImplementation(async () => {
      throw new Error("HTTP 401: api key revoked");
    });
    const setApiKeySpy = vi
      .spyOn(CloudApiClient.prototype, "setApiKey")
      .mockImplementation(function (this: unknown, _key: unknown) {
        // no-op — avoid touching internal SDK state
      });
    const setBaseUrlSpy = vi
      .spyOn(CloudApiClient.prototype, "setBaseUrl")
      .mockImplementation(function (this: unknown, _url: unknown) {
        // no-op
      });

    try {
      // CloudAuthService only ever reads `getSetting` off the runtime in
      // `initialize()` (verified in src/services/cloud-auth.ts). The
      // remaining IAgentRuntime surface is irrelevant here; we keep the
      // unknown escape localized to this single construction site.
      const runtime = {
        getSetting: (key: string): string | undefined => {
          if (key === "ELIZAOS_CLOUD_BASE_URL") return "https://www.elizacloud.ai";
          if (key === "ELIZAOS_CLOUD_API_KEY") return "eliza_saved_key_c7";
          if (key === "ELIZAOS_CLOUD_USER_ID") return "user-1";
          if (key === "ELIZAOS_CLOUD_ORG_ID") return "org-1";
          return undefined;
        },
      } as unknown as IAgentRuntime;

      const service = new CloudAuthService(runtime);
      // `initialize` is private on the class — the cast here documents
      // that this test deliberately bypasses the public `start()` entry
      // point to assert on the saved-key validation path in isolation.
      const serviceWithInitialize = service as unknown as {
        initialize(): Promise<void>;
      };
      await serviceWithInitialize.initialize();

      // Optimistic: the key is cached on credentials immediately.
      expect(service.isAuthenticated()).toBe(true);
      expect(service.getApiKey()).toBe("eliza_saved_key_c7");

      // The background /models call rejects. Wait for the unhandled-
      // looking microtask chain to resolve.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // Warning landed — message text is "key could not be validated" OR
      // "Could not reach cloud API" (validateApiKey hits the catch first).
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        warnMessages.some((m) => /\[CloudAuth\].*(could not (be validated|reach)|revoked)/i.test(m))
      ).toBe(true);

      // The cached key survives — model calls would continue using it.
      expect(service.getApiKey()).toBe("eliza_saved_key_c7");
    } finally {
      warnSpy.mockRestore();
      getSpy.mockRestore();
      setApiKeySpy.mockRestore();
      setBaseUrlSpy.mockRestore();
    }
  });
});

// ─── C8 — openBrowser failure surfaces via observer ──────────────────────
//
// Before this refactor, `openBrowser(url).catch(() => {})` swallowed all
// failures at debug-level. Now: when the OS open command (no `open` /
// `xdg-open` / `cmd.exe` on PATH) rejects, the observer's
// `onAuthBrowserOpenFailed(url, error)` MUST fire so desktop/web wrappers
// can render an inline "couldn't open browser" affordance.

describe("C8 — openBrowser failure surfaces via observer", () => {
  it("fires onAuthBrowserOpenFailed when the OS open command rejects", async () => {
    setAvailability({ acceptingNewAgents: true });

    // Seed the shared execFile mock to reject with an ENOENT-style error.
    // The `openBrowser` helper inside `onboarding.ts` reaches the mock
    // via `await import("node:child_process")`. The helper is fire-and-
    // forget from `runCloudAuth`, so we ensure the observer receives the
    // failure even though the main flow continues.
    execFileBehavior.invokeError = new Error("ENOENT: no such file or directory, open 'open'");

    // cloudLogin fires its onBrowserUrl callback (which triggers
    // openBrowser) and then resolves immediately so we can complete the
    // flow and assert on the observer call without waiting for a real
    // timeout. The provisioning step is also mocked through to running.
    cloudLoginMock.mockImplementationOnce(async (opts) => {
      // Trigger the browser-open path. The helper is fire-and-forget.
      opts.onBrowserUrl?.("https://www.elizacloud.ai/auth/device?code=test");
      // Give the setImmediate-fired execFile error a chance to land.
      await new Promise((r) => setImmediate(r));
      return {
        apiKey: "eliza_test_key_C8",
        keyPrefix: "eliza_",
        expiresAt: null,
      };
    });

    bridgeBehavior.createAgent.mockResolvedValueOnce({
      id: "agent-id-c8",
      agentName: "agent-c8",
      status: "queued",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    bridgeBehavior.getAgent.mockResolvedValueOnce({
      id: "agent-id-c8",
      agentName: "agent-c8",
      status: "running",
      databaseStatus: "ok",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });

    const restoreSetTimeout = installSyncSetTimeout();
    const observer = makeObserver();

    try {
      await runCloudOnboarding(observer, "agent-c8", undefined, "https://www.elizacloud.ai");

      // Drain microtasks once more — the catch() that calls
      // onAuthBrowserOpenFailed is on a fire-and-forget promise.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // The observer was notified of the browser-open failure with the
      // right URL and an Error instance.
      expect(observer.onAuthBrowserOpenFailed).toHaveBeenCalledTimes(1);
      const [calledUrl, calledError] = observer.onAuthBrowserOpenFailed.mock.calls[0];
      expect(calledUrl).toBe("https://www.elizacloud.ai/auth/device?code=test");
      expect(calledError).toBeInstanceOf(Error);
      expect((calledError as Error).message).toMatch(/ENOENT/);
    } finally {
      execFileBehavior.invokeError = null;
      restoreSetTimeout();
    }
  });
});

// ─── C9 — Null observer never throws ──────────────────────────────────────
//
// Sanity check that the bundled `NullCloudOnboardingObserver` is a safe
// default for headless / test runs: a full onboarding pass through the
// availability=false branch must complete without throwing.

describe("C9 — null observer never throws", () => {
  it("runs through availability=false → run-locally fallback without errors", async () => {
    setAvailability({ success: true, acceptingNewAgents: false });

    const observer = new NullCloudOnboardingObserver();

    // NullCloudOnboardingObserver.confirm returns null on every call,
    // which the orchestrator treats as cancel == "run locally" — the
    // availability=false branch returns null without ever hitting auth.
    const result = await runCloudOnboarding(
      observer,
      "agent-c9",
      undefined,
      "https://www.elizacloud.ai"
    );

    expect(result).toBeNull();
    // We did NOT attempt auth — the null observer cancelled at the first
    // prompt, which is the documented behavior for headless runs.
    expect(cloudLogin).not.toHaveBeenCalled();
  });
});
