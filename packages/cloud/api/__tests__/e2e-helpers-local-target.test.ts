// Exercises cloud API tests e2e helpers local target.test behavior with deterministic Worker route fixtures.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  api,
  getBaseUrl,
  isLocalTarget,
  sameOriginBrowserHeaders,
} from "../test/e2e/_helpers/api";

/**
 * Pins the shared isLocalTarget() e2e helper (test/e2e/_helpers/api.ts) that
 * group-a-auth and group-h-misc both import: internal-bearer tests must run
 * against local dev Workers and skip against deployed (staging/prod) targets.
 */
describe("e2e _helpers isLocalTarget", () => {
  const savedApiBaseUrl = process.env.TEST_API_BASE_URL;
  const savedBaseUrl = process.env.TEST_BASE_URL;

  beforeEach(() => {
    delete process.env.TEST_API_BASE_URL;
    delete process.env.TEST_BASE_URL;
  });

  afterEach(() => {
    if (savedApiBaseUrl === undefined) delete process.env.TEST_API_BASE_URL;
    else process.env.TEST_API_BASE_URL = savedApiBaseUrl;
    if (savedBaseUrl === undefined) delete process.env.TEST_BASE_URL;
    else process.env.TEST_BASE_URL = savedBaseUrl;
  });

  test("uses the same getBaseUrl it lives beside (default localhost:8787)", () => {
    expect(getBaseUrl()).toBe("http://localhost:8787");
    expect(isLocalTarget()).toBe(true);
  });

  test.each([
    "http://localhost:8787",
    "http://localhost/",
    "http://localhost",
    "http://127.0.0.1:8787",
    "http://0.0.0.0:8787",
  ])("true for local target %s", (baseUrl) => {
    process.env.TEST_API_BASE_URL = baseUrl;
    expect(isLocalTarget()).toBe(true);
  });

  test.each([
    "https://api.elizacloud.ai",
    "https://staging-api.elizacloud.ai",
    "https://localhost.example.com",
    "https://mylocalhost:8787",
  ])("false for deployed/lookalike target %s", (baseUrl) => {
    process.env.TEST_API_BASE_URL = baseUrl;
    expect(isLocalTarget()).toBe(false);
  });

  test("adds the configured target origin only when explicitly requested", () => {
    process.env.TEST_API_BASE_URL = "https://staging-api.elizacloud.ai/api";

    expect(sameOriginBrowserHeaders({ Cookie: "session=test" })).toEqual({
      Origin: "https://staging-api.elizacloud.ai",
      "x-eliza-csrf": "1",
      Cookie: "session=test",
    });
  });

  test("preserves an explicit cross-origin value for negative coverage", () => {
    process.env.TEST_API_BASE_URL = "https://staging-api.elizacloud.ai";

    expect(
      sameOriginBrowserHeaders({ Origin: "https://attacker.example" }),
    ).toEqual({ Origin: "https://attacker.example", "x-eliza-csrf": "1" });
    expect(
      sameOriginBrowserHeaders({ origin: "https://attacker.example" }),
    ).toEqual({ origin: "https://attacker.example", "x-eliza-csrf": "1" });
    // The marker itself is also caller-overridable for negative coverage.
    expect(
      sameOriginBrowserHeaders({ "x-eliza-csrf": "" }).Origin,
    ).toBeDefined();
  });

  test("does not add Origin to ordinary API helper requests", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await api.post("/api/csrf-negative", { test: true });

    const requestInit = fetchSpy.mock.calls[0]?.[1];
    expect(new Headers(requestInit?.headers).has("Origin")).toBe(false);
    fetchSpy.mockRestore();
  });
});
