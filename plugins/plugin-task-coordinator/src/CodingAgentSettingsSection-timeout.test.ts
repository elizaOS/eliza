/**
 * Coding-agent settings deadlines through the canonical ElizaClient seam.
 * Native Android/iOS bridges discard RequestInit.signal; timeoutMs on
 * rawRequest is the context that reaches Agent.request.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: {
    getConfig: async () => ({ env: {}, cloud: {} }),
    fetchModels: async () => null,
    updateConfig: async () => undefined,
    rawRequest: async () => new Response(null, { status: 204 }),
  },
}));

vi.mock("@elizaos/ui/state", () => ({
  useAppSelector: () => ({}),
}));

vi.mock("lucide-react", () => ({
  ExternalLink: () => null,
  Terminal: () => null,
}));

vi.mock("./AgentTabsSection", () => ({ AgentTabsSection: () => null }));
vi.mock("./GitHubConnectionCard", () => ({ GitHubConnectionCard: () => null }));
vi.mock("./GlobalPrefsSection", () => ({ GlobalPrefsSection: () => null }));
vi.mock("./LlmProviderSection", () => ({ LlmProviderSection: () => null }));
vi.mock("./ModelConfigSection", () => ({ ModelConfigSection: () => null }));

import {
  CODING_AGENTS_AUTH_FETCH_TIMEOUT_MS,
  CODING_AGENTS_PREFLIGHT_FETCH_TIMEOUT_MS,
  getCodingAgentsPreflightWithClient,
  postCodingAgentsAuthWithClient,
} from "./CodingAgentSettingsSection";

describe("coding-agent settings client deadlines", () => {
  it("keeps a documented 15s budget per hop", () => {
    expect(CODING_AGENTS_PREFLIGHT_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(CODING_AGENTS_AUTH_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("forwards the preflight deadline and unmount signal on rawRequest", async () => {
    const rawRequest = vi.fn(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    const unmount = new AbortController();

    await expect(
      getCodingAgentsPreflightWithClient({ rawRequest }, 3210, unmount.signal),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(rawRequest).toHaveBeenCalledWith(
      "/api/coding-agents/preflight",
      { signal: unmount.signal },
      { allowNonOk: true, timeoutMs: 3210 },
    );
  });

  it("surfaces a provider error from a completed preflight GET", async () => {
    const rawRequest = vi.fn(async () => new Response("nope", { status: 503 }));

    const response = await getCodingAgentsPreflightWithClient(
      { rawRequest },
      1_000,
    );
    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
    expect(rawRequest).toHaveBeenCalledWith(
      "/api/coding-agents/preflight",
      undefined,
      { allowNonOk: true, timeoutMs: 1_000 },
    );
  });

  it("uses the client seam for a successful preflight GET", async () => {
    const rawRequest = vi.fn(async () =>
      Response.json([{ adapter: "claude", installed: true }]),
    );

    const response = await getCodingAgentsPreflightWithClient(
      { rawRequest },
      1_000,
    );
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual([
      { adapter: "claude", installed: true },
    ]);
  });

  it("forwards the auth POST deadline on rawRequest", async () => {
    const rawRequest = vi.fn(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });

    await expect(
      postCodingAgentsAuthWithClient("claude", { rawRequest }, 4321),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(rawRequest).toHaveBeenCalledWith(
      "/api/coding-agents/auth/claude",
      { method: "POST" },
      { allowNonOk: true, timeoutMs: 4321 },
    );
  });

  it("surfaces a provider error from a completed auth POST", async () => {
    const rawRequest = vi.fn(async () => new Response("nope", { status: 503 }));

    const response = await postCodingAgentsAuthWithClient(
      "claude",
      { rawRequest },
      1_000,
    );
    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
  });

  it("uses the client seam for a successful auth POST", async () => {
    const rawRequest = vi.fn(async () => Response.json({ launched: true }));

    const response = await postCodingAgentsAuthWithClient(
      "claude",
      { rawRequest },
      1_000,
    );
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ launched: true });
  });
});
