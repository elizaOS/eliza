/**
 * Behavioral coding-agent settings deadlines. Executes
 * getCodingAgentsPreflightWithFetch and postCodingAgentsAuthWithFetch
 * under abort — not a source-grep. Separate 15s hop budgets.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: {
    getConfig: async () => ({ env: {}, cloud: {} }),
    fetchModels: async () => null,
    updateConfig: async () => undefined,
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
  getCodingAgentsPreflightWithFetch,
  postCodingAgentsAuthWithFetch,
} from "./CodingAgentSettingsSection";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected coding-agents abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("coding-agent settings independent request deadlines", () => {
  it("keeps a documented 15s budget per hop", () => {
    expect(CODING_AGENTS_PREFLIGHT_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(CODING_AGENTS_AUTH_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled preflight GET at its own deadline", async () => {
    await expect(
      getCodingAgentsPreflightWithFetch(stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed preflight GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });
    const response = await getCodingAgentsPreflightWithFetch(fetchImpl, 1_000);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
  });

  it("uses the injected fetch for a successful preflight GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json([{ adapter: "claude", installed: true }]);
    };
    const response = await getCodingAgentsPreflightWithFetch(fetchImpl, 1_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(response.ok).toBe(true);
  });

  it("aborts a stalled auth POST at its own deadline", async () => {
    await expect(
      postCodingAgentsAuthWithFetch("claude", stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed auth POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });
    const response = await postCodingAgentsAuthWithFetch(
      "claude",
      fetchImpl,
      1_000,
    );
    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
  });

  it("uses the injected fetch for a successful auth POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ launched: true });
    };
    const response = await postCodingAgentsAuthWithFetch(
      "claude",
      fetchImpl,
      1_000,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(response.ok).toBe(true);
  });
});
