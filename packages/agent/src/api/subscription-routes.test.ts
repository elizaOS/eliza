/**
 * Exercises the legacy OpenAI exchange boundary when an account OAuth flow
 * owns the live PKCE verifier; provider transport remains behind its injected seam.
 */
import type http from "node:http";
import type { AccountCredentialRecord } from "@elizaos/auth/account-storage";
import type { OAuthFlowHandle } from "@elizaos/auth/oauth-flow";
import { describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/types.eliza.ts";
import {
  handleSubscriptionRoutes,
  type SubscriptionAuthApi,
  type SubscriptionRouteContext,
} from "./subscription-routes.ts";

const CALLBACK =
  "http://localhost:1455/auth/callback?code=codex-code&state=flow-state";

function account(expires = 123_456): AccountCredentialRecord {
  return {
    id: "account-1",
    providerId: "openai-codex",
    label: "Personal",
    source: "oauth",
    credentials: {
      access: "access-token",
      refresh: "refresh-token",
      expires,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function accountFlow(
  completion: OAuthFlowHandle["completion"],
): OAuthFlowHandle {
  return {
    sessionId: "session-1",
    authUrl: "https://auth.openai.com/authorize?state=flow-state",
    needsCodeSubmission: true,
    completion,
    submitCode: vi.fn(),
    cancel: vi.fn(),
  };
}

function context(args: {
  submit: SubscriptionAuthApi["submitProviderFlowCode"];
  json?: ReturnType<typeof vi.fn>;
  error?: ReturnType<typeof vi.fn>;
}): SubscriptionRouteContext {
  return {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/subscription/openai/exchange",
    state: { config: {} as ElizaConfig },
    saveConfig: vi.fn(),
    readJsonBody: vi.fn().mockResolvedValue({ code: CALLBACK }),
    json: args.json ?? vi.fn(),
    error: args.error ?? vi.fn(),
    loadSubscriptionAuth: vi.fn().mockResolvedValue({
      submitProviderFlowCode: args.submit,
    } as SubscriptionAuthApi),
  } as unknown as SubscriptionRouteContext;
}

describe("subscription OpenAI account-flow bridge", () => {
  it("submits the callback to the matching account flow and awaits persistence", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const flow = accountFlow(Promise.resolve({ account: account() }));
    const submit = vi.fn().mockReturnValue(flow);

    const handled = await handleSubscriptionRoutes(
      context({ submit, json, error }),
    );

    expect(handled).toBe(true);
    expect(submit).toHaveBeenCalledWith("openai-codex", CALLBACK);
    expect(json).toHaveBeenCalledWith(expect.anything(), {
      success: true,
      expiresAt: 123_456,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects a callback that cannot be matched to one pending flow", async () => {
    const json = vi.fn();
    const error = vi.fn();

    await handleSubscriptionRoutes(
      context({ submit: vi.fn().mockReturnValue(null), json, error }),
    );

    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "No matching active flow — start login again",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("translates account-flow exchange failure at the HTTP boundary", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const flow = accountFlow(Promise.reject(new Error("provider rejected")));

    await handleSubscriptionRoutes(
      context({ submit: vi.fn().mockReturnValue(flow), json, error }),
    );

    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "OpenAI exchange failed",
      500,
    );
    expect(json).not.toHaveBeenCalled();
  });
});
