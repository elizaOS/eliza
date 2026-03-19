/**
 * Tests for cloud-onboarding.ts
 *
 * Mocks fetch, @clack/prompts, and the cloud auth/bridge modules to verify
 * the orchestration logic without requiring a live Eliza Cloud instance.
 */

import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any imports that pull in
// the module under test.
// ---------------------------------------------------------------------------

// Mock the cloud auth module
const mockCloudLogin = vi.fn();
vi.mock("../cloud/auth", () => ({
  cloudLogin: (...args: unknown[]) => mockCloudLogin(...args),
}));

// Mock the cloud bridge client
const mockCreateAgent = vi.fn();
const mockGetAgent = vi.fn();
vi.mock("../cloud/bridge-client", () => ({
  ElizaCloudClient: class {
    createAgent = mockCreateAgent;
    getAgent = mockGetAgent;
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import {
  type CloudOnboardingResult,
  checkCloudAvailability,
  runCloudOnboarding,
} from "./cloud-onboarding";

// ---------------------------------------------------------------------------
// Helpers — fake @clack/prompts module
// ---------------------------------------------------------------------------

function makeClack(
  overrides: { selectReturn?: string; confirmReturns?: boolean[] } = {},
) {
  const { selectReturn = "cloud", confirmReturns = [] } = overrides;
  let confirmIdx = 0;

  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
    },
    spinner: () => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    }),
    select: vi.fn().mockResolvedValue(selectReturn),
    confirm: vi.fn().mockImplementation(() => {
      const val = confirmReturns[confirmIdx] ?? true;
      confirmIdx++;
      return Promise.resolve(val);
    }),
    isCancel: vi.fn().mockReturnValue(false),
  } as unknown as typeof import("@clack/prompts");
}

// ---------------------------------------------------------------------------
// checkCloudAvailability
// ---------------------------------------------------------------------------

describe("checkCloudAvailability", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when cloud is accepting new agents", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { acceptingNewAgents: true, availableSlots: 5 },
      }),
    }) as unknown as typeof fetch;

    const result = await checkCloudAvailability("https://www.elizacloud.ai");
    expect(result).toBeNull();
  });

  it("returns error message when cloud is at capacity", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { acceptingNewAgents: false, availableSlots: 0 },
      }),
    }) as unknown as typeof fetch;

    const result = await checkCloudAvailability("https://www.elizacloud.ai");
    expect(result).toContain("at capacity");
  });

  it("returns error message when cloud returns HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as unknown as typeof fetch;

    const result = await checkCloudAvailability("https://www.elizacloud.ai");
    expect(result).toContain("503");
  });

  it("returns error message when fetch throws (network error)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const result = await checkCloudAvailability("https://www.elizacloud.ai");
    expect(result).toContain("ECONNREFUSED");
  });

  it("returns timeout message on timeout", async () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(err) as unknown as typeof fetch;

    const result = await checkCloudAvailability("https://www.elizacloud.ai");
    expect(result).toContain("timed out");
  });

  it("normalises the base URL before fetching", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { acceptingNewAgents: true, availableSlots: 1 },
      }),
    }) as unknown as typeof fetch;
    globalThis.fetch = mockFetch;

    await checkCloudAvailability("https://elizacloud.ai/api/v1/");

    // normalizeCloudSiteUrl should strip the /api/v1 and add www
    const calledUrl = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(calledUrl).toContain("www.elizacloud.ai");
    expect(calledUrl).toContain("/api/compat/availability");
    expect(calledUrl).not.toContain("/api/v1/api/compat");
  });
});

// ---------------------------------------------------------------------------
// runCloudOnboarding
// ---------------------------------------------------------------------------

describe("runCloudOnboarding", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockCloudLogin.mockReset();
    mockCreateAgent.mockReset();
    mockGetAgent.mockReset();

    // Default: cloud is available
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { acceptingNewAgents: true, availableSlots: 5 },
      }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns full result when auth + provisioning succeed", async () => {
    const clack = makeClack();

    mockCloudLogin.mockResolvedValue({
      apiKey: "test-key-123",
      keyPrefix: "test",
      expiresAt: null,
    });

    mockCreateAgent.mockResolvedValue({
      id: "agent-abc",
      status: "running",
    });

    mockGetAgent.mockResolvedValue({
      status: "running",
      bridgeUrl: "https://bridge.example.com",
    });

    const result = await runCloudOnboarding(
      clack,
      "TestAgent",
      undefined,
      "https://www.elizacloud.ai",
    );

    assert(result != null, "expected a non-null result");
    expect(result.apiKey).toBe("test-key-123");
    expect(result.agentId).toBe("agent-abc");
    expect(result.baseUrl).toContain("elizacloud.ai");
  });

  it("returns null when cloud is unavailable and user falls back to local", async () => {
    const clack = makeClack({ confirmReturns: [true] }); // "run locally?"

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { acceptingNewAgents: false, availableSlots: 0 },
      }),
    }) as unknown as typeof fetch;

    const result = await runCloudOnboarding(
      clack,
      "TestAgent",
      undefined,
      "https://www.elizacloud.ai",
    );

    expect(result).toBeNull();
    expect(mockCloudLogin).not.toHaveBeenCalled();
  });

  it("returns null when auth fails and user declines retry", async () => {
    const clack = makeClack({ confirmReturns: [false] }); // "run locally" (cancel)

    mockCloudLogin.mockResolvedValue(null);

    const result = await runCloudOnboarding(
      clack,
      "TestAgent",
      undefined,
      "https://www.elizacloud.ai",
    );

    expect(result).toBeNull();
    expect(mockCloudLogin).toHaveBeenCalledTimes(1);
  });

  it("retries auth once when user requests it", async () => {
    const clack = makeClack({ confirmReturns: [true] }); // "try again"

    // First attempt fails, second succeeds
    mockCloudLogin.mockResolvedValueOnce(null).mockResolvedValueOnce({
      apiKey: "retry-key",
      keyPrefix: "retry",
      expiresAt: null,
    });

    mockCreateAgent.mockResolvedValue({
      id: "agent-retry",
      status: "running",
    });

    mockGetAgent.mockResolvedValue({
      status: "running",
      bridgeUrl: "https://bridge.example.com",
    });

    const result = await runCloudOnboarding(
      clack,
      "TestAgent",
      undefined,
      "https://www.elizacloud.ai",
    );

    expect(mockCloudLogin).toHaveBeenCalledTimes(2);
    assert(result != null, "expected a non-null result after retry");
    expect(result.apiKey).toBe("retry-key");
  });

  it("returns auth-only result (agentId undefined) when provisioning fails and user declines local", async () => {
    // User declines "continue with local setup?" AND declines "run locally?"
    const clack = makeClack({ confirmReturns: [false] });

    mockCloudLogin.mockResolvedValue({
      apiKey: "auth-only-key",
      keyPrefix: "auth",
      expiresAt: null,
    });

    // provisionCloudAgent fails
    mockCreateAgent.mockRejectedValue(new Error("quota exceeded"));

    const result = await runCloudOnboarding(
      clack,
      "TestAgent",
      undefined,
      "https://www.elizacloud.ai",
    );

    assert(result != null, "expected a non-null auth-only result");
    expect(result.apiKey).toBe("auth-only-key");
    expect(result.agentId).toBeUndefined();
  });

  it("returns null when provisioning fails and user wants local", async () => {
    const clack = makeClack({ confirmReturns: [true] }); // "continue with local?"

    mockCloudLogin.mockResolvedValue({
      apiKey: "key-123",
      keyPrefix: "k",
      expiresAt: null,
    });

    mockCreateAgent.mockRejectedValue(new Error("server error"));

    const result = await runCloudOnboarding(
      clack,
      "TestAgent",
      undefined,
      "https://www.elizacloud.ai",
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// provisionCloudAgent — tested indirectly via runCloudOnboarding
// ---------------------------------------------------------------------------

describe("provisionCloudAgent (via runCloudOnboarding)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockCloudLogin.mockReset();
    mockCreateAgent.mockReset();
    mockGetAgent.mockReset();

    // Cloud is available
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { acceptingNewAgents: true, availableSlots: 5 },
      }),
    }) as unknown as typeof fetch;

    // Auth always succeeds
    mockCloudLogin.mockResolvedValue({
      apiKey: "test-key",
      keyPrefix: "test",
      expiresAt: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("polls until agent reaches running status", { timeout: 15_000 }, async () => {
    const clack = makeClack();

    mockCreateAgent.mockResolvedValue({
      id: "agent-poll",
      status: "provisioning",
    });

    // First poll: still provisioning. Second poll: running.
    mockGetAgent
      .mockResolvedValueOnce({ status: "provisioning" })
      .mockResolvedValueOnce({
        status: "running",
        bridgeUrl: "https://bridge.test",
      });

    const result = await runCloudOnboarding(
      clack,
      "PollAgent",
      undefined,
      "https://www.elizacloud.ai",
    );

    assert(result != null, "expected a non-null result after polling");
    expect(result.agentId).toBe("agent-poll");
    expect(result.bridgeUrl).toBe("https://bridge.test");
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
  });

  it("returns null when agent provisioning fails with error status", async () => {
    const clack = makeClack({ confirmReturns: [true] }); // fall back to local

    mockCreateAgent.mockResolvedValue({
      id: "agent-fail",
      status: "provisioning",
    });

    mockGetAgent.mockResolvedValue({
      status: "failed",
      errorMessage: "out of resources",
    });

    const result = await runCloudOnboarding(
      clack,
      "FailAgent",
      undefined,
      "https://www.elizacloud.ai",
    );

    // Falls back to null because user chose local
    expect(result).toBeNull();
  });

  it("passes style preset through to createAgent", async () => {
    const clack = makeClack();

    mockCreateAgent.mockResolvedValue({
      id: "agent-styled",
      status: "running",
    });

    mockGetAgent.mockResolvedValue({
      status: "running",
      bridgeUrl: "https://bridge.test",
    });

    const preset = {
      catchphrase: "test",
      bio: ["A test agent"],
      system: "You are a test agent.",
      adjectives: ["testy"],
      topics: ["testing"],
    };

    await runCloudOnboarding(
      clack,
      "StyledAgent",
      preset as Parameters<typeof runCloudOnboarding>[2],
      "https://www.elizacloud.ai",
    );

    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const params = mockCreateAgent.mock.calls[0][0];
    expect(params.agentName).toBe("StyledAgent");
    expect(params.agentConfig.bio).toEqual(["A test agent"]);
    expect(params.agentConfig.system).toBe("You are a test agent.");
  });
});

// ---------------------------------------------------------------------------
// CloudOnboardingResult interface
// ---------------------------------------------------------------------------

describe("CloudOnboardingResult", () => {
  it("agentId accepts string value", () => {
    const result: CloudOnboardingResult = {
      apiKey: "key",
      agentId: "agent-123",
      baseUrl: "https://example.com",
    };
    expect(result.agentId).toBe("agent-123");
  });

  it("agentId accepts undefined", () => {
    const result: CloudOnboardingResult = {
      apiKey: "key",
      agentId: undefined,
      baseUrl: "https://example.com",
    };
    expect(result.agentId).toBeUndefined();
  });
});
