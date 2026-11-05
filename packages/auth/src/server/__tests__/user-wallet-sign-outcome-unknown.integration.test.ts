/**
 * Exercises a broadcast user-wallet payment through the loopback server, PGlite
 * state and a local JSON-RPC node whose eth_sendRawTransaction response is
 * lost. The client retry must not send a second payment.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const appOrigin = "https://eliza.app";
const chainId = 84532;

type JsonRpcRequest = { id: number; method: string; params?: unknown[] };

function rpcResult(method: string): unknown {
  switch (method) {
    case "eth_chainId":
      return `0x${chainId.toString(16)}`;
    case "eth_getTransactionCount":
      return "0x0";
    case "eth_getCode":
      return "0x";
    case "eth_getBalance":
      return "0x8ac7230489e80000";
    case "eth_estimateGas":
      return "0x5208";
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      return "0x3b9aca00";
    case "eth_blockNumber":
      return "0x1";
    case "eth_getBlockByNumber":
      return {
        number: "0x1",
        hash: `0x${"11".repeat(32)}`,
        parentHash: `0x${"00".repeat(32)}`,
        timestamp: "0x1",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        baseFeePerGas: "0x3b9aca00",
        transactions: [],
      };
    default:
      return undefined;
  }
}

async function login(origin: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  return async (tenantId?: string) => {
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
      headers: {
        "Content-Type": "application/json",
        Origin: appOrigin,
        ...(tenantId ? { "X-Steward-Tenant": tenantId } : {}),
      },
      body: JSON.stringify({
        message,
        signature: await account.signMessage({ message }),
      }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
}

test("user wallet sign with a lost broadcast response does not pay twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-user-sign-unknown-"));
  const environment = {
    NODE_ENV: "production",
    STEWARD_ACK_LOCAL_CUSTODY: "true",
    STEWARD_PGLITE_PATH: directory,
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    PASSKEY_RP_ID: "eliza.app",
    PASSKEY_ORIGIN: appOrigin,
    APP_URL: appOrigin,
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

  let sendRawTransactionCalls = 0;
  const rpc = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      if (calls.some((call) => call.method === "eth_sendRawTransaction")) {
        sendRawTransactionCalls += 1;
        // The node may have accepted the bytes; the response is lost.
        response.writeHead(500).end("upstream connection reset");
        return;
      }
      const replies = calls.map((call) => {
        const result = rpcResult(call.method);
        return result === undefined
          ? {
              jsonrpc: "2.0",
              id: call.id,
              error: { code: -32000, message: `${call.method} unavailable` },
            }
          : { jsonrpc: "2.0", id: call.id, result };
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(Array.isArray(parsed) ? replies : replies[0]),
      );
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));
  const { EVM_CHAIN_RPCS } = await import("../wallet/evm-chains");
  const previousRpc = EVM_CHAIN_RPCS[chainId];
  EVM_CHAIN_RPCS[chainId] =
    `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;

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
    expect({ status: enroll.status, error: enrolled.error }).toEqual({
      status: 200,
      error: undefined,
    });
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
    // The user wallet routes need a personal-tenant session. Email and phone
    // sign-in create this tenant; this test signs in with a wallet.
    const personalTenant = `personal-${first.user.id}`;
    const { getDb } = await import("../db/client");
    const { tenants } = await import("../db/schema");
    const { userTenants } = await import("../db/schema-auth");
    await getDb()
      .insert(tenants)
      .values({ id: personalTenant, name: "personal", apiKeyHash: "unused" });
    await getDb().insert(userTenants).values({
      userId: first.user.id,
      tenantId: personalTenant,
      role: "owner",
    });
    const challenged = await signIn(personalTenant);
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
    expect({ status: complete.status, error: session.error }).toEqual({
      status: 200,
      error: undefined,
    });
    const auth = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
      Origin: appOrigin,
    };

    const provisioned = await fetch(`${origin}/user/me/wallet`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    const wallet = await provisioned.json();
    expect({ status: provisioned.status, error: wallet.error }).toEqual({
      status: 201,
      error: undefined,
    });
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const halfEth = "500000000000000000";
    const sign = (idempotencyKey: string, value: string) =>
      fetch(`${origin}/user/me/wallet/sign`, {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ to: recipient, value, chainId }),
      });

    // 0.5 ETH: the node takes the bytes but the response is lost.
    const firstResponse = await sign("user-sign-0001", halfEth);
    const firstBody = await firstResponse.json();
    const retryResponse = await sign("user-sign-0001", halfEth);
    const retryBody = await retryResponse.json();

    expect(sendRawTransactionCalls).toBe(1);
    expect(firstResponse.status).toBe(202);
    expect(firstBody.data.reconciliationRequired).toBe(true);
    const txHash: string = firstBody.data.txHash;
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(retryResponse.status).toBe(202);
    expect(retryBody.data.txHash).toBe(txHash);

    // Each possibly-sent payment counts against the default 2 ETH daily
    // limit, so the fifth 0.5 ETH payment is rejected.
    const hashes = [txHash];
    for (const key of ["user-sign-0002", "user-sign-0003", "user-sign-0004"]) {
      const response = await sign(key, halfEth);
      expect(response.status).toBe(202);
      hashes.push((await response.json()).data.txHash);
    }
    const overLimit = await sign("user-sign-0005", halfEth);
    expect(overLimit.status).toBe(403);
    expect(sendRawTransactionCalls).toBe(4);

    const history = await fetch(`${origin}/user/me/wallet/history`, {
      headers: auth,
    });
    const historyBody = await history.json();
    expect(history.status).toBe(200);
    expect(
      historyBody.data.transactions.map(
        (tx: { status: string; txHash?: string }) => ({
          status: tx.status,
          txHash: tx.txHash,
        }),
      ),
    ).toEqual(
      hashes
        .reverse()
        .map((hash) => ({ status: "outcome_unknown", txHash: hash })),
    );
  } finally {
    await server?.stop();
    EVM_CHAIN_RPCS[chainId] = previousRpc;
    await new Promise((resolve) => rpc.close(resolve));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
