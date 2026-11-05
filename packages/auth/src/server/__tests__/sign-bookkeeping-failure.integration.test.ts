/**
 * Exercises a broadcast sign through the loopback server, PGlite state and a
 * local JSON-RPC node that accepts the transaction. The post-broadcast audit
 * write then fails. The sent payment must stay recorded as broadcast.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
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

test("a bookkeeping failure after broadcast keeps the payment recorded as sent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-sign-bookkeeping-"));
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
      const replies = calls.map((call) => {
        if (call.method === "eth_sendRawTransaction") {
          sendRawTransactionCalls += 1;
          return {
            jsonrpc: "2.0",
            id: call.id,
            result: keccak256(call.params?.[0] as `0x${string}`),
          };
        }
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
        {
          id: "daily-cap",
          type: "spending-limit",
          enabled: true,
          config: { maxPerTx: "1000", maxPerDay: "1500", maxPerWeek: "1500" },
        },
      ]),
    });
    const policyResult = await policies.json();
    expect({ status: policies.status, error: policyResult.error }).toEqual({
      status: 200,
      error: undefined,
    });

    // The audit store fails for the post-broadcast vault.sign event only.
    const { getDb } = await import("../db/client");
    const { sql } = await import("drizzle-orm");
    await getDb().execute(
      sql.raw(`CREATE FUNCTION reject_vault_sign_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'vault.sign' THEN
            RAISE EXCEPTION 'audit store unavailable';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`),
    );
    await getDb().execute(
      sql.raw(`CREATE TRIGGER reject_vault_sign_audit BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION reject_vault_sign_audit()`),
    );

    const sign = (idempotencyKey = "sign-0001") =>
      fetch(`${origin}/vault/${agentId}/sign`, {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ to: recipient, value: "1000", chainId }),
      });
    const response = await sign();
    const body = await response.json();
    expect(sendRawTransactionCalls).toBe(1);
    expect({ status: response.status, error: body.error }).toEqual({
      status: 200,
      error: undefined,
    });
    const txHash: string = body.data.txHash;
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The client retry gets the same result and the node gets no second send.
    const retry = await sign();
    expect(retry.status).toBe(200);
    expect((await retry.json()).data.txHash).toBe(txHash);
    expect(sendRawTransactionCalls).toBe(1);

    // The sent 1000 wei counts against the 1500 wei daily cap.
    const second = await sign("sign-0002");
    expect(second.status).toBe(403);
    expect(sendRawTransactionCalls).toBe(1);

    const { transactions } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb()
      .select({ status: transactions.status, txHash: transactions.txHash })
      .from(transactions)
      .where(eq(transactions.id, body.data.txId));
    expect(rows).toEqual([{ status: "broadcast", txHash }]);
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
