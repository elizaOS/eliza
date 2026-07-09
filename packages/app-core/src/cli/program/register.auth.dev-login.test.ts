/**
 * Tests for the dev SIWE wallet login (`runDevWalletLogin`): generate an
 * ephemeral Ethereum wallet, sign the SIWE challenge, and exchange it for a
 * cloud API key with no browser/OAuth. A fixed private key plus a mocked fetch
 * keep the suite offline and deterministic; covers the mint-without-save happy
 * path, a transient nonce-failure retry, a verify rejection, and the loud
 * failed-persist warning (config write throws → saveError + manual-save
 * instructions, never a silent muted aside).
 */
import { describe, expect, it, vi } from "vitest";
import { runDevWalletLogin } from "./register.auth";

// The persist path dynamically imports these; the throwing saveConfig drives
// the failed-persist test (the other tests run with save:false and never reach it).
vi.mock("./register.setup", () => ({
  resolveConfigPath: () => "/nonexistent/eliza/eliza.json",
  loadConfig: () => ({}),
  saveConfig: () => {
    throw new Error("EACCES: permission denied");
  },
}));

const FIXED_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function mockFetch(opts?: {
  nonceStatus?: number;
  verifyStatus?: number;
  captureMessage?: (msg: string) => void;
}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/auth/siwe/nonce")) {
      const status = opts?.nonceStatus ?? 200;
      if (status !== 200) {
        return new Response("nope", { status });
      }
      return new Response(
        JSON.stringify({
          nonce: "abc123nonce",
          domain: "www.elizacloud.ai",
          uri: "https://www.elizacloud.ai",
          chainId: 1,
          version: "1",
          statement: "Sign in to Eliza Cloud",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/api/auth/siwe/verify")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        message: string;
        signature: string;
      };
      opts?.captureMessage?.(body.message);
      const status = opts?.verifyStatus ?? 200;
      if (status !== 200) return new Response("bad", { status });
      // The signature must be a 65-byte hex EIP-191 personal_sign.
      expect(body.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
      return new Response(
        JSON.stringify({
          apiKey: "eliza_devkey_TESTKEY",
          address: "0x...",
          isNewAccount: true,
          organization: { id: "org-test-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("auth dev-login (SIWE wallet)", () => {
  it("generates a wallet, signs SIWE, and returns the minted key (no save)", async () => {
    let captured = "";
    const result = await runDevWalletLogin({
      privateKey: FIXED_PK,
      save: false,
      log: () => {},
      fetchImpl: mockFetch({ captureMessage: (m) => (captured = m) }),
    });
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe("eliza_devkey_TESTKEY");
    expect(result.isNewAccount).toBe(true);
    expect(result.organizationId).toBe("org-test-1");
    expect(result.savedTo).toBeNull();
    // The fixed key derives a stable, checksummed address.
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The signed message is a valid EIP-4361 SIWE message.
    expect(captured).toContain(
      "wants you to sign in with your Ethereum account:",
    );
    expect(captured).toContain("Sign in to Eliza Cloud");
    expect(captured).toContain("URI: https://www.elizacloud.ai");
    expect(captured).toContain("Nonce: abc123nonce");
    expect(captured).toContain("Chain ID: 1");
    expect(captured).toContain(result.address as string);
  });

  it("retries a transient nonce failure", async () => {
    let calls = 0;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/nonce")) {
        calls += 1;
        if (calls < 2) return new Response("500", { status: 500 });
      }
      return mockFetch()(url as string, init);
    }) as unknown as typeof fetch;
    const result = await runDevWalletLogin({
      privateKey: FIXED_PK,
      save: false,
      log: () => {},
      fetchImpl: flaky,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("reports a clear failure when verify rejects", async () => {
    const result = await runDevWalletLogin({
      privateKey: FIXED_PK,
      save: false,
      log: () => {},
      fetchImpl: mockFetch({ verifyStatus: 401 }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("verify failed (401)");
  });

  it("a failed key persist is LOUD: warns, returns saveError, and prints manual-save instructions", async () => {
    const lines: string[] = [];
    const result = await runDevWalletLogin({
      privateKey: FIXED_PK,
      // save defaults to true → the mocked saveConfig throws EACCES.
      log: (line) => lines.push(line),
      fetchImpl: mockFetch(),
    });

    // The mint itself still succeeds and the key is returned.
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe("eliza_devkey_TESTKEY");
    // The failure is a first-class result field, not a swallowed aside.
    expect(result.savedTo).toBeNull();
    expect(result.saveError).toContain("EACCES: permission denied");
    // And the user is told, loudly, with a copy-pasteable remedy.
    const output = lines.join("\n");
    expect(output).toContain("WARNING: failed to save ELIZAOS_CLOUD_API_KEY");
    expect(output).toContain("NOT saved");
    expect(output).toContain(
      "export ELIZAOS_CLOUD_API_KEY=eliza_devkey_TESTKEY",
    );
  });
});
