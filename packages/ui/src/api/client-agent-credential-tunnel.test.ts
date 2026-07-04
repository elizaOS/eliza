/**
 * Unit coverage for `tunnelCredential` posting scoped credentials to the
 * credential-tunnel route. Transport stubbed, no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import { ElizaClient } from "./client-base";

describe("ElizaClient.tunnelCredential", () => {
  it("posts scoped credential values to /api/credential-tunnel", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => ({
      ok: true,
      childSessionId: "pty-1-abc",
      credentialScopeId: "cred_scope_test",
      key: "OPENAI_API_KEY",
    }));
    client.fetch = fetch as typeof client.fetch;

    const result = await client.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: "cred_scope_test",
      key: "OPENAI_API_KEY",
      value: "sk-test-12345",
    });

    expect(fetch).toHaveBeenCalledWith("/api/credential-tunnel", {
      method: "POST",
      body: JSON.stringify({
        childSessionId: "pty-1-abc",
        credentialScopeId: "cred_scope_test",
        key: "OPENAI_API_KEY",
        value: "sk-test-12345",
      }),
    });
    expect(result).toEqual({
      ok: true,
      childSessionId: "pty-1-abc",
      credentialScopeId: "cred_scope_test",
      key: "OPENAI_API_KEY",
    });
  });
});
