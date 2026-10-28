/**
 * Regression coverage for the OAuth 2.0 PKCE callback boundary: the pasted
 * redirect must include the generated anti-CSRF state before token exchange.
 * Deterministic provider test; interactive I/O and token HTTP are mocked.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import type { TokenStore } from "./token-store";

vi.mock("./interactive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interactive")>()),
  waitForLoopbackCallback: vi.fn(async () => {
    throw new Error("loopback unavailable");
  }),
  promptForRedirectedUrl: vi.fn(
    async () => "http://127.0.0.1/callback?code=auth-code",
  ),
}));

function createRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: vi.fn(
      (key: string) =>
        ({
          TWITTER_CLIENT_ID: "client-id",
          TWITTER_REDIRECT_URI: "http://127.0.0.1/callback",
        })[key],
    ),
  } as unknown as IAgentRuntime;
}

function createStore(): TokenStore {
  return {
    load: vi.fn(async () => null),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

describe("OAuth2PKCEAuthProvider", () => {
  it("rejects a pasted redirect that omits state before exchanging the code", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new OAuth2PKCEAuthProvider(
      createRuntime(),
      undefined,
      createStore(),
      fetchImpl,
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "OAuth state mismatch",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
