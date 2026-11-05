/**
 * Exercises SPL token transfer actions through the loopback server, PGlite
 * state and a local Solana JSON-RPC node. USD spending limits must price the
 * token amount with the token mint, not with the SOL price.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONERO_ON_SOLANA, WRAPPED_NATIVE } from "../shared/tokens";

const appOrigin = "https://eliza.app";
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

type JsonRpcRequest = { id: number; method: string; params?: unknown[] };

async function login(origin: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  return async () => {
    const nonceResponse = await fetch(`${origin}/auth/nonce`, {
      headers: { Origin: appOrigin },
    });
    expect(nonceResponse.status).toBe(200);
    const { nonce } = await nonceResponse.json();
    const message = [
      "eliza.app wants you to sign in with your Ethereum account:",
      account.address,
      "",
      "Sign in to elizaOS",
      "",
      `URI: ${appOrigin}`,
      "Version: 1",
      "Chain ID: 1",
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const response = await fetch(`${origin}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: appOrigin },
      body: JSON.stringify({
        message,
        signature: await account.signMessage({ message }),
      }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
}

test("USD spending limits price SPL token transfers with the token mint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-spl-usd-limit-"));
  // A six-decimal stablecoin mint that the price oracle has no decimals for.
  const stablecoinMint = Keypair.generate().publicKey.toBase58();
  const mintDecimals = new Map([
    [stablecoinMint, 6],
    [MONERO_ON_SOLANA.address, MONERO_ON_SOLANA.decimals],
  ]);

  const rpc = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(raw) as JsonRpcRequest;
      let result: unknown;
      if (call.method === "getAccountInfo") {
        const decimals = mintDecimals.get(String(call.params?.[0]));
        result = {
          context: { slot: 1 },
          value:
            decimals === undefined
              ? null
              : {
                  data: {
                    parsed: {
                      info: {
                        decimals,
                        isInitialized: true,
                        supply: "1000000000000000",
                        freezeAuthority: null,
                        mintAuthority: null,
                      },
                      type: "mint",
                    },
                    program: "spl-token",
                    space: 82,
                  },
                  executable: false,
                  lamports: 1461600,
                  owner: tokenProgram,
                  rentEpoch: 0,
                  space: 82,
                },
        };
      } else if (call.method === "getLatestBlockhash") {
        result = {
          context: { slot: 1 },
          value: {
            blockhash: Keypair.generate().publicKey.toBase58(),
            lastValidBlockHeight: 100,
          },
        };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          result === undefined
            ? {
                jsonrpc: "2.0",
                id: call.id,
                error: { code: -32601, message: `${call.method} unavailable` },
              }
            : { jsonrpc: "2.0", id: call.id, result },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));

  const environment = {
    NODE_ENV: "production",
    STEWARD_ACK_LOCAL_CUSTODY: "true",
    STEWARD_PGLITE_PATH: directory,
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_EXECUTION_AUTH_SECRET: randomBytes(32).toString("hex"),
    PASSKEY_RP_ID: "eliza.app",
    PASSKEY_ORIGIN: appOrigin,
    APP_URL: appOrigin,
    RPC_URL: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`,
  };
  const previous = new Map(
    [
      ...Object.keys(environment),
      "STEWARD_EMBEDDED",
      "STEWARD_DB_MODE",
      "STEWARD_KDF_SALT",
      "STEWARD_AUDIT_HMAC_KEY",
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  delete process.env.STEWARD_KDF_SALT;
  delete process.env.STEWARD_AUDIT_HMAC_KEY;

  // The real price oracle runs unchanged. Only the DexScreener endpoint is
  // answered locally: SOL (through the wrapped SOL mint) $150, the
  // stablecoin $1, wXMR $150. Everything else, including the native SOL
  // price the daily and weekly caps need, goes through the shipped code.
  const dexPrices: Record<string, number> = {
    [WRAPPED_NATIVE[101]]: 150,
    [stablecoinMint]: 1,
    [MONERO_ON_SOLANA.address]: 150,
  };
  const dexTokensUrl = "https://api.dexscreener.com/latest/dex/tokens/";
  const realFetch = globalThis.fetch;
  const localDexFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(dexTokensUrl)) return realFetch(input, init);
    const price = dexPrices[decodeURIComponent(url.slice(dexTokensUrl.length))];
    return Response.json({
      pairs:
        price === undefined
          ? []
          : [
              {
                chainId: "solana",
                priceUsd: String(price),
                liquidity: { usd: 1_000_000 },
              },
            ],
    });
  };
  globalThis.fetch = localDexFetch as typeof fetch;

  const { startEmbeddedLogin } = await import("../embedded");
  const { generateTotp } = await import("../auth/totp");
  let server: Awaited<ReturnType<typeof startEmbeddedLogin>> | undefined;
  try {
    server = await startEmbeddedLogin({ port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    const signIn = await login(origin);

    // Enrol TOTP so the owner session can carry recent MFA for signing.
    const first = await signIn();
    const enroll = await fetch(`${origin}/auth/mfa/totp/enroll`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${first.token}`,
        "Content-Type": "application/json",
        Origin: appOrigin,
      },
      body: "{}",
    });
    const enrolled = await enroll.json();
    expect(enroll.status).toBe(200);
    const enable = await fetch(`${origin}/auth/mfa/totp/verify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${first.token}`,
        "Content-Type": "application/json",
        Origin: appOrigin,
      },
      body: JSON.stringify({
        code: await generateTotp(enrolled.secret, {
          time: Date.now() - 30_000,
        }),
      }),
    });
    expect(enable.status).toBe(200);
    await Bun.sleep(1_100);
    const challenged = await signIn();
    expect(challenged.mfaRequired).toBe(true);
    const complete = await fetch(`${origin}/auth/mfa/totp/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: appOrigin },
      body: JSON.stringify({
        challengeId: challenged.mfa.challengeId,
        code: await generateTotp(enrolled.secret, {
          time: Date.now() + 30_000,
        }),
      }),
    });
    const session = await complete.json();
    expect(complete.status).toBe(200);
    const auth = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
      Origin: appOrigin,
    };

    const created = await fetch(`${origin}/agents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "payments" }),
    });
    const agent = await created.json();
    expect({ status: created.status, error: agent.error }).toEqual({
      status: 200,
      error: undefined,
    });
    const agentId: string = agent.data.id;
    const recipient = Keypair.generate().publicKey.toBase58();
    const policies = await fetch(`${origin}/agents/${agentId}/policies`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify([
        {
          id: "allow-recipient-and-mints",
          type: "approved-addresses",
          enabled: true,
          config: {
            mode: "whitelist",
            addresses: [recipient, stablecoinMint, MONERO_ON_SOLANA.address],
          },
        },
        {
          id: "usd-cap",
          type: "spending-limit",
          enabled: true,
          config: { maxPerTxUsd: 100, maxPerDayUsd: 100, maxPerWeekUsd: 100 },
        },
      ]),
    });
    const policyResult = await policies.json();
    expect({ status: policies.status, error: policyResult.error }).toEqual({
      status: 200,
      error: undefined,
    });

    const transfer = (token: string, value: string) =>
      fetch(`${origin}/vault/${agentId}/actions/transfer`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          to: recipient,
          token,
          value,
          chainId: 101,
          broadcast: false,
        }),
      });

    // 666 stablecoin units are $666, over the $100 cap. The oracle has no
    // decimals for this mint, so the USD cap cannot price it and must refuse.
    const stablecoin = await transfer(stablecoinMint, "666000000");
    const stablecoinBody = await stablecoin.json();
    expect({
      status: stablecoin.status,
      transfer: stablecoinBody.data?.status,
      reasons: stablecoinBody.data?.policyResults
        ?.filter((result: { passed: boolean }) => !result.passed)
        .map((result: { reason: string }) => result.reason),
    }).toEqual({
      status: 403,
      transfer: "rejected",
      reasons: ["USD spending limit cannot be evaluated for chain 101"],
    });

    // 0.1 SOL at $150 is $15: native SOL is priced through the wrapped mint.
    const sol = await transfer("native", "100000000");
    const solBody = await sol.json();
    expect({
      status: sol.status,
      reasons: solBody.data?.policyResults
        ?.filter((result: { passed: boolean }) => !result.passed)
        .map((result: { reason: string }) => result.reason),
    }).toEqual({ status: 200, reasons: [] });

    // 0.5 wXMR at $150 is $75. The daily and weekly caps price the 0.1 SOL
    // spent so far through the native price: $15 + $75 stays under $100.
    const monero = await transfer(MONERO_ON_SOLANA.address, "500000000000");
    const moneroBody = await monero.json();
    expect({ status: monero.status, error: moneroBody.error }).toEqual({
      status: 200,
      error: undefined,
    });
  } finally {
    await server?.stop();
    globalThis.fetch = realFetch;
    await new Promise((resolve) => rpc.close(resolve));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
