/**
 * Exercises a broadcast native transfer through the loopback server, PGlite
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
      return "0xde0b6b3a7640000";
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

test("lost broadcast response returns outcome-unknown and the retry does not pay twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-transfer-unknown-"));
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
    expect({ status: complete.status, error: session.error }).toEqual({
      status: 200,
      error: undefined,
    });
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
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const policies = await fetch(`${origin}/agents/${agentId}/policies`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify([
        {
          id: "allow-recipient",
          type: "approved-addresses",
          enabled: true,
          config: { mode: "whitelist", addresses: [recipient] },
        },
      ]),
    });
    const policyResult = await policies.json();
    expect({ status: policies.status, error: policyResult.error }).toEqual({
      status: 200,
      error: undefined,
    });

    const transfer = (idempotencyKey = "transfer-retry-0001") =>
      fetch(`${origin}/vault/${agentId}/actions/transfer`, {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          to: recipient,
          value: "1000",
          chainId,
          token: "native",
          broadcast: true,
          referenceId: "ref-1",
        }),
      });

    const firstResponse = await transfer();
    const firstBody = await firstResponse.json();
    const retryResponse = await transfer();
    const retryBody = await retryResponse.json();

    expect(sendRawTransactionCalls).toBe(1);
    expect(firstResponse.status).toBe(202);
    expect(firstBody.data.reconciliationRequired).toBe(true);
    const txHash: string = firstBody.data.txHash;
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(retryResponse.status).toBe(202);
    expect(retryBody.data.txHash).toBe(txHash);
    // A retry under a new Idempotency-Key still resolves by referenceId.
    const rekeyed = await transfer("transfer-retry-0002");
    const rekeyedBody = await rekeyed.json();
    expect(sendRawTransactionCalls).toBe(1);
    expect(rekeyed.status).toBe(200);
    expect(rekeyedBody.data).toMatchObject({
      id: firstBody.data.txId,
      status: "outcome_unknown",
      txHash,
    });

    const { getDb } = await import("../db/client");
    const { transactions } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb()
      .select({
        id: transactions.id,
        status: transactions.status,
        txHash: transactions.txHash,
        actionType: transactions.actionType,
      })
      .from(transactions)
      .where(eq(transactions.agentId, agentId));
    expect(rows).toEqual([
      {
        id: firstBody.data.txId,
        status: "outcome_unknown",
        txHash,
        actionType: "transfer",
      },
    ]);
    // The ambiguous broadcast is accounted for like /sign does: the audit row
    // is written (the spend aggregation it records alongside is kept in Redis
    // and is not readable in this embedded test environment).
    const { auditEvents } = await import("../db/schema");
    const audits = await getDb()
      .select({
        action: auditEvents.action,
        resourceId: auditEvents.resourceId,
      })
      .from(auditEvents)
      .where(eq(auditEvents.action, "vault.broadcast.outcome_unknown"));
    expect(audits).toEqual([
      {
        action: "vault.broadcast.outcome_unknown",
        resourceId: firstBody.data.txId,
      },
    ]);
    const action = await fetch(
      `${origin}/vault/${agentId}/actions/${firstBody.data.txId}`,
      { headers: auth },
    );
    const actionBody = await action.json();
    expect(action.status).toBe(200);
    expect(actionBody.data.txHash).toBe(txHash);
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
