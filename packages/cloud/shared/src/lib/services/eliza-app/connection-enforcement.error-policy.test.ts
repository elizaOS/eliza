// Pins the fail-closed contract of the connection-enforcement gate: an internal cache/oauth
// failure must PROPAGATE (throw), and stay distinguishable from a legitimately-negative
// "no required connection" result. Deterministic fixtures — no live cache or oauth.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const cacheGet = mock();
const cacheSet = mock();
const getConnectedPlatforms = mock();

mock.module("../../cache/client", () => ({
  cache: {
    get: cacheGet,
    set: cacheSet,
    del: mock(async () => {}),
    delPattern: mock(async () => {}),
  },
}));

mock.module("../oauth", () => ({
  oauthService: {
    getConnectedPlatforms,
    initiateAuth: mock(async () => ({ authUrl: null })),
  },
}));

mock.module("../../providers/language-model", () => ({
  getLanguageModel: mock(() => "mock-model"),
  hasLanguageModelProviderConfigured: mock(() => true),
}));

mock.module("../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

mock.module("ai", () => ({
  generateText: mock(async () => ({ text: "unused in this suite" })),
}));

const { connectionEnforcementService } = await import(
  `./connection-enforcement.ts?test=connection-enforcement-error-policy-${Date.now()}`
);

const ORG = "org-1";
const USER = "user-1";

describe("ConnectionEnforcementService.hasRequiredConnection — fail-closed contract", () => {
  beforeEach(() => {
    cacheGet.mockReset();
    cacheSet.mockReset();
    getConnectedPlatforms.mockReset();
    cacheSet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cacheGet.mockReset();
    cacheSet.mockReset();
    getConnectedPlatforms.mockReset();
  });

  test("designed-empty: no connected platforms returns false (distinct from failure)", async () => {
    cacheGet.mockResolvedValue(null);
    getConnectedPlatforms.mockResolvedValue([]);

    const result = await connectionEnforcementService.hasRequiredConnection(ORG, USER);

    expect(result).toBe(false);
    // A legitimately-negative result is cached and returned — not thrown.
    expect(cacheSet).toHaveBeenCalledTimes(1);
    expect(cacheSet.mock.calls[0]?.[1]).toBe(false);
  });

  test("returns true when a required platform is connected", async () => {
    cacheGet.mockResolvedValue(null);
    getConnectedPlatforms.mockResolvedValue(["google", "slack"]);

    const result = await connectionEnforcementService.hasRequiredConnection(ORG, USER);

    expect(result).toBe(true);
    expect(cacheSet.mock.calls[0]?.[1]).toBe(true);
  });

  test("serves a cached boolean without querying oauth", async () => {
    cacheGet.mockResolvedValue(false);

    const result = await connectionEnforcementService.hasRequiredConnection(ORG, USER);

    expect(result).toBe(false);
    expect(getConnectedPlatforms).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  test("PROPAGATES an oauth failure instead of fabricating connected=true (fail closed)", async () => {
    cacheGet.mockResolvedValue(null);
    getConnectedPlatforms.mockRejectedValue(new Error("oauth provider down"));

    // Pre-fix this returned `true` (fail-open, bypassing enforcement). Now it must reject.
    await expect(connectionEnforcementService.hasRequiredConnection(ORG, USER)).rejects.toThrow(
      "oauth provider down",
    );
    // Never caches a fabricated status when the check failed.
    expect(cacheSet).not.toHaveBeenCalled();
  });

  test("PROPAGATES a cache read failure instead of assuming connected", async () => {
    cacheGet.mockRejectedValue(new Error("cache unreachable"));

    await expect(connectionEnforcementService.hasRequiredConnection(ORG, USER)).rejects.toThrow(
      "cache unreachable",
    );
    expect(getConnectedPlatforms).not.toHaveBeenCalled();
  });
});
