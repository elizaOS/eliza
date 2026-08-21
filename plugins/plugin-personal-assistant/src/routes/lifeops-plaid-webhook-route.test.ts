/**
 * Route-boundary proof for the public Plaid webhook receiver at
 * POST /api/lifeops/money/plaid/webhook: HTTP-shaped requests travel the real
 * LifeOps route dispatcher → FinancesService.handlePlaidWebhook → ES256
 * verification (JWK fetched over real HTTP from a local cloud stub) → sync
 * dispatch → PGLite rows. The harness is integration-backed: real PGlite
 * runtime with the finances plugin, real WebCrypto signatures from a locally
 * generated P-256 key, and a real HTTP server standing in for Eliza Cloud.
 * Rejection paths assert zero cloud traffic and zero state change — a forged,
 * unsigned, or oversized delivery must never reach the lifecycle code.
 */

import { createHash, webcrypto } from "node:crypto";
import {
  createServer,
  IncomingMessage,
  type Server,
  ServerResponse,
} from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { FinancesRepository } from "@elizaos/plugin-finances/db/finances-repository";
import { FinancesService } from "@elizaos/plugin-finances/finances-service";
import financesPlugin from "@elizaos/plugin-finances/plugin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../packages/app-core/test/helpers/real-runtime.ts";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "./lifeops-routes.js";

process.env.ELIZA_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
// Point config resolution at a nonexistent file so an ambient developer
// ~/.eliza config cannot override the stub cloud credentials below.
process.env.ELIZA_CONFIG_PATH = "/nonexistent/eliza-test-config.json";

const subtle = webcrypto.subtle;

interface SignedWebhook {
  rawBody: string;
  verificationJwt: string;
  keyId: string;
}

let publicJwk: Record<string, unknown>;
let privateKey: CryptoKey;

async function initSigningKey(): Promise<void> {
  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = keyPair.privateKey;
  publicJwk = (await subtle.exportKey("jwk", keyPair.publicKey)) as Record<
    string,
    unknown
  >;
}

async function signWebhook(
  body: Record<string, unknown>,
): Promise<SignedWebhook> {
  const keyId = "route-test-key";
  const rawBody = JSON.stringify(body);
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      request_body_sha256: createHash("sha256")
        .update(rawBody, "utf8")
        .digest("hex"),
    }),
  ).toString("base64url");
  const signature = Buffer.from(
    await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      Buffer.from(`${header}.${claims}`, "utf8"),
    ),
  ).toString("base64url");
  return {
    rawBody,
    verificationJwt: `${header}.${claims}.${signature}`,
    keyId,
  };
}

interface CloudStub {
  server: Server;
  baseUrl: string;
  /** Request paths received, in order — rejection cases assert this stays empty. */
  calls: string[];
}

/**
 * Minimal Eliza Cloud stand-in serving the three Plaid bridge endpoints this
 * lifecycle path uses. Response DTO shapes mirror the real cloud routes.
 */
async function startCloudStub(): Promise<CloudStub> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      calls.push(path);
      const respond = (payload: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (path.endsWith("/eliza/plaid/webhook-key")) {
        respond({ key: publicJwk });
        return;
      }
      if (path.endsWith("/eliza/plaid/exchange")) {
        respond({
          accessToken: "access-route-item",
          itemId: "route-item-1",
          institution: {
            institutionId: "ins_route",
            institutionName: "Route Test Bank",
            primaryAccountMask: "9876",
            accounts: [
              {
                accountId: "route-acct-1",
                name: "Checking",
                mask: "9876",
                type: "depository",
                subtype: "checking",
              },
            ],
          },
        });
        return;
      }
      if (path.endsWith("/eliza/plaid/sync")) {
        respond({
          added: [
            {
              transaction_id: "route-txn-1",
              account_id: "route-acct-1",
              amount: 21.5,
              iso_currency_code: "USD",
              unofficial_currency_code: null,
              date: "2026-08-02",
              authorized_date: null,
              name: "Route Coffee",
              merchant_name: null,
              pending: false,
              category: null,
              personal_finance_category: {
                primary: "FOOD",
                detailed: "FOOD_COFFEE",
              },
            },
          ],
          modified: [],
          removed: [],
          nextCursor: "route-c1",
          hasMore: false,
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected path ${path}` }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("cloud stub failed to bind");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, calls };
}

interface CapturedResponse {
  statusCode?: number;
  body?: string;
  ended: boolean;
}

function buildWebhookCtx(args: {
  runtime: AgentRuntime;
  rawBody?: Buffer;
  verificationJwt?: string;
}): { ctx: LifeOpsRouteContext; res: CapturedResponse } {
  const captured: CapturedResponse = { ended: false };
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const httpReq = new IncomingMessage(socket);
  httpReq.method = "POST";
  httpReq.headers = {
    "content-type": "application/json",
    ...(args.verificationJwt
      ? { "plaid-verification": args.verificationJwt }
      : {}),
  };
  if (args.rawBody) {
    httpReq.push(args.rawBody);
  }
  httpReq.push(null);

  const httpRes = new ServerResponse(httpReq);
  httpRes.statusCode = 0;
  httpRes.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    captured.ended = true;
    captured.body = typeof chunk === "string" ? chunk : "";
    captured.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };

  const pathname = "/api/lifeops/money/plaid/webhook";
  const ctx: LifeOpsRouteContext = {
    req: httpReq,
    res: httpRes,
    method: "POST",
    pathname,
    url: new URL(`http://localhost${pathname}`),
    state: { runtime: args.runtime, adminEntityId: null },
    json(r, data, status = 200) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify(data));
    },
    error(r, message, status = 400) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify({ error: message }));
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      throw new Error("webhook route must read raw bytes, not JSON helper");
    },
    decodePathComponent(raw) {
      return raw;
    },
  };
  return { ctx, res: captured };
}

describe("Plaid webhook production route (real runtime + HTTP key lookup)", () => {
  let testResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let repository: FinancesRepository;
  let stub: CloudStub;
  let sourceId: string;

  beforeAll(async () => {
    await initSigningKey();
    stub = await startCloudStub();
    process.env.ELIZAOS_CLOUD_API_KEY = "test-route-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = stub.baseUrl;
    testResult = await createRealTestRuntime({
      characterName: "plaid-webhook-route-tests",
      plugins: [financesPlugin],
    });
    runtime = testResult.runtime;
    repository = new FinancesRepository(runtime);
    // Link one real source through the service so the receiver has an Item
    // to route to; the exchange travels the stub cloud over real HTTP.
    const service = new FinancesService(runtime);
    const source = await service.completePlaidLink({
      publicToken: "public-route-token",
    });
    sourceId = source.id;
    stub.calls.length = 0;
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
    await new Promise<void>((resolve, reject) =>
      stub.server.close((error) => (error ? reject(error) : resolve())),
    );
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  });

  it("dispatches a correctly signed webhook exactly once through the production route", async () => {
    const signed = await signWebhook({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "route-item-1",
    });
    const { ctx, res } = buildWebhookCtx({
      runtime,
      rawBody: Buffer.from(signed.rawBody, "utf8"),
      verificationJwt: signed.verificationJwt,
    });
    const handled = await handleLifeOpsRoutes(ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({
      handled: true,
      action: "sync",
      sourceId,
    });
    // Verification key lookup happened, then exactly one sync dispatch.
    expect(
      stub.calls.filter((path) => path.endsWith("/eliza/plaid/webhook-key")),
    ).toHaveLength(1);
    expect(
      stub.calls.filter((path) => path.endsWith("/eliza/plaid/sync")),
    ).toHaveLength(1);
    const rows = await repository.listPaymentTransactions(runtime.agentId, {
      sourceId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe("route-txn-1");
  });

  it("rejects a tampered body with 401 and performs zero service work", async () => {
    stub.calls.length = 0;
    const signed = await signWebhook({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "route-item-1",
    });
    const tampered = Buffer.from(
      signed.rawBody.replace("route-item-1", "route-item-EVIL"),
      "utf8",
    );
    const { ctx, res } = buildWebhookCtx({
      runtime,
      rawBody: tampered,
      verificationJwt: signed.verificationJwt,
    });
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(401);
    // The key lookup by kid is allowed; nothing beyond it may run.
    expect(
      stub.calls.filter((path) => path.endsWith("/eliza/plaid/sync")),
    ).toHaveLength(0);
    expect(
      await repository.listPaymentTransactions(runtime.agentId, { sourceId }),
    ).toHaveLength(1);
  });

  it("rejects a missing Plaid-Verification header with 401 before any cloud traffic", async () => {
    stub.calls.length = 0;
    const { ctx, res } = buildWebhookCtx({
      runtime,
      rawBody: Buffer.from(
        JSON.stringify({
          webhook_type: "TRANSACTIONS",
          webhook_code: "SYNC_UPDATES_AVAILABLE",
          item_id: "route-item-1",
        }),
        "utf8",
      ),
    });
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects an oversized body with 413 before verification or cloud traffic", async () => {
    stub.calls.length = 0;
    const signed = await signWebhook({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "route-item-1",
    });
    const oversized = Buffer.alloc(64 * 1024 + 1, 0x61);
    const { ctx, res } = buildWebhookCtx({
      runtime,
      rawBody: oversized,
      verificationJwt: signed.verificationJwt,
    });
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(413);
    expect(stub.calls).toHaveLength(0);
  });

  it("reports an unknown item as unhandled without touching local sources", async () => {
    stub.calls.length = 0;
    const signed = await signWebhook({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "route-item-unknown",
    });
    const { ctx, res } = buildWebhookCtx({
      runtime,
      rawBody: Buffer.from(signed.rawBody, "utf8"),
      verificationJwt: signed.verificationJwt,
    });
    await handleLifeOpsRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({
      handled: false,
      sourceId: null,
    });
    expect(
      stub.calls.filter((path) => path.endsWith("/eliza/plaid/sync")),
    ).toHaveLength(0);
  });
});
