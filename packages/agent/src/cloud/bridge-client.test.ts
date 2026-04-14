/**
 * Tests for ElizaCloudClient wallet methods:
 *   - getAgentWallet
 *   - provisionWallet
 *   - executeRpc (body-embedded wallet-signature auth, error mapping)
 *
 * Uses a local HTTP server with a real ElizaCloudClient so fetch is exercised
 * end-to-end without mocks.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CloudBridgeError,
  CloudUnavailableError,
  ElizaCloudClient,
  NonceReplayError,
  SessionExpiredError,
  SignatureInvalidError,
  type SignedRpcEnvelope,
} from "./bridge-client";

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
) => void;

let server: http.Server;
let serverPort: number;
let nextHandler: Handler | null = null;
let lastRequest: {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
} | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      lastRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      if (nextHandler) {
        nextHandler(req, res, body);
      } else {
        res.writeHead(500).end("no handler");
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  nextHandler = null;
  lastRequest = null;
});

function client(): ElizaCloudClient {
  return new ElizaCloudClient(`http://127.0.0.1:${serverPort}`, "test-api-key");
}

function envelope(
  overrides: Partial<SignedRpcEnvelope> = {},
): SignedRpcEnvelope {
  return {
    clientAddress: "0xabcdef0123456789abcdef0123456789abcdef01",
    payload: { method: "personal_sign", params: ["0xhello"] },
    nonce: "nonce-1",
    timestamp: Date.now(),
    signature: `0x${"11".repeat(65)}`,
    ...overrides,
  };
}

describe("getAgentWallet", () => {
  it("returns a typed descriptor for a provisioned wallet", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          success: true,
          data: {
            agentId: "agent-42",
            walletAddress: "0xcafebabecafebabecafebabecafebabecafebabe",
            walletAddresses: {
              evm: "0xcafebabecafebabecafebabecafebabecafebabe",
              solana: "So11111111111111111111111111111111111111112",
            },
            walletProvider: "steward",
            walletStatus: "active",
            balance: "1.23",
            chain: "base",
          },
        }),
      );
    };

    const d = await client().getAgentWallet("agent-42", "evm");

    expect(d).toEqual({
      agentWalletId: "agent-42",
      walletAddress: "0xcafebabecafebabecafebabecafebabecafebabe",
      walletProvider: "steward",
      chainType: "evm",
      balance: "1.23",
    });
    expect(lastRequest?.headers["x-api-key"]).toBe("test-api-key");
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.url).toBe(
      "/api/v1/milady/agents/agent-42/wallet?chain=evm",
    );
  });

  it("selects the requested chain from walletAddresses", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          success: true,
          data: {
            agentId: "agent-42",
            walletAddress: "0xcafebabecafebabecafebabecafebabecafebabe",
            walletAddresses: {
              evm: "0xcafebabecafebabecafebabecafebabecafebabe",
              solana: "So11111111111111111111111111111111111111112",
            },
            walletProvider: "steward",
            walletStatus: "active",
            balance: "0.42",
          },
        }),
      );
    };

    const d = await client().getAgentWallet("agent-42", "solana");

    expect(d).toEqual({
      agentWalletId: "agent-42",
      walletAddress: "So11111111111111111111111111111111111111112",
      walletProvider: "steward",
      chainType: "solana",
      balance: "0.42",
    });
    expect(lastRequest?.url).toBe(
      "/api/v1/milady/agents/agent-42/wallet?chain=solana",
    );
  });

  it("rejects a chain-mismatched flat wallet address", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          success: true,
          data: {
            agentId: "agent-42",
            walletAddress: "0xcafebabecafebabecafebabecafebabecafebabe",
            walletProvider: "steward",
            walletStatus: "active",
          },
        }),
      );
    };

    await expect(client().getAgentWallet("agent-42", "solana")).rejects.toThrow(
      /no cloud solana wallet/i,
    );
  });

  it("throws when no cloud wallet is provisioned", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          success: true,
          data: {
            agentId: "agent-42",
            walletAddress: null,
            walletProvider: null,
            walletStatus: "none",
            balance: null,
            chain: null,
          },
        }),
      );
    };

    await expect(client().getAgentWallet("agent-42", "evm")).rejects.toThrow(
      /no cloud evm wallet/i,
    );
  });
});

describe("provisionWallet", () => {
  it("POSTs with X-Api-Key auth and returns typed result", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          success: true,
          data: {
            id: "wallet-uuid-1",
            address: "0xfeedface00000000000000000000000000000000",
            chainType: "evm",
            clientAddress: "0xclient",
            provider: "privy",
          },
        }),
      );
    };

    const r = await client().provisionWallet({
      chainType: "evm",
      clientAddress: "0xclient",
    });

    expect(r).toEqual({
      walletId: "wallet-uuid-1",
      address: "0xfeedface00000000000000000000000000000000",
      chainType: "evm",
      provider: "privy",
    });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe("/api/v1/user/wallets/provision");
    expect(lastRequest?.headers["x-api-key"]).toBe("test-api-key");
    expect(JSON.parse(lastRequest?.body)).toEqual({
      chainType: "evm",
      clientAddress: "0xclient",
    });
  });

  it("defaults provider to privy when server omits it", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          success: true,
          data: {
            id: "w2",
            address: "SolanaAddrXYZ",
            chainType: "solana",
            clientAddress: "SolClient",
          },
        }),
      );
    };

    const r = await client().provisionWallet({
      chainType: "solana",
      clientAddress: "SolClient",
    });

    expect(r.provider).toBe("privy");
    expect(r.chainType).toBe("solana");
  });

  it("surfaces validation details from cloud error responses", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          success: false,
          error: "Validation error",
          details: [
            { message: "Invalid Solana address (base58, 32–44 chars)" },
          ],
        }),
      );
    };

    await expect(
      client().provisionWallet({
        chainType: "solana",
        clientAddress: "0xclient",
      }),
    ).rejects.toThrow(
      /Validation error: Invalid Solana address \(base58, 32–44 chars\)/,
    );
  });

  it("normalizes canonical cloud URLs in the constructor", () => {
    const withLegacyHost = new ElizaCloudClient(
      "https://elizacloud.ai/api/v1",
      "test-api-key",
    ) as unknown as { baseUrl: string };
    const withCanonicalHost = new ElizaCloudClient(
      "https://www.elizacloud.ai/api/v1",
      "test-api-key",
    ) as unknown as { baseUrl: string };

    expect(withLegacyHost.baseUrl).toBe("https://www.elizacloud.ai");
    expect(withCanonicalHost.baseUrl).toBe("https://www.elizacloud.ai");
  });
});

describe("executeRpc", () => {
  it("posts body envelope WITHOUT bearer or X-Api-Key auth header", async () => {
    nextHandler = (_req, res) => {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ success: true, data: { txHash: "0xdead" } }));
    };

    const env = envelope();
    const result = await client().executeRpc(env);

    expect(result).toEqual({ txHash: "0xdead" });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe("/api/v1/user/wallets/rpc");
    // Critical: NO bearer, NO x-api-key — signature lives in body only.
    expect(lastRequest?.headers.authorization).toBeUndefined();
    expect(lastRequest?.headers["x-api-key"]).toBeUndefined();
    const parsed = JSON.parse(lastRequest?.body);
    expect(parsed).toEqual({
      clientAddress: env.clientAddress,
      payload: env.payload,
      nonce: env.nonce,
      timestamp: env.timestamp,
      signature: env.signature,
    });
  });

  it("passes correlationId via X-Correlation-Id and does not leak into body", async () => {
    nextHandler = (_req, res) => {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ success: true, data: { ok: true } }));
    };

    await client().executeRpc(envelope({ correlationId: "corr-123" }));

    expect(lastRequest?.headers["x-correlation-id"]).toBe("corr-123");
    const parsed = JSON.parse(lastRequest?.body);
    expect(parsed.correlationId).toBeUndefined();
  });

  it("maps 401 to SignatureInvalidError", async () => {
    nextHandler = (_req, res) => {
      res
        .writeHead(401, { "Content-Type": "application/json" })
        .end(
          JSON.stringify({ success: false, error: "Invalid wallet signature" }),
        );
    };

    await expect(client().executeRpc(envelope())).rejects.toBeInstanceOf(
      SignatureInvalidError,
    );
  });

  it("maps 409 to NonceReplayError", async () => {
    nextHandler = (_req, res) => {
      res
        .writeHead(409, { "Content-Type": "application/json" })
        .end(JSON.stringify({ success: false, error: "nonce replay" }));
    };

    await expect(client().executeRpc(envelope())).rejects.toBeInstanceOf(
      NonceReplayError,
    );
  });

  it("maps 410 to SessionExpiredError", async () => {
    nextHandler = (_req, res) => {
      res
        .writeHead(410, { "Content-Type": "application/json" })
        .end(JSON.stringify({ success: false, error: "session gone" }));
    };

    await expect(client().executeRpc(envelope())).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("maps 5xx to CloudUnavailableError", async () => {
    nextHandler = (_req, res) => {
      res
        .writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ success: false, error: "upstream" }));
    };

    await expect(client().executeRpc(envelope())).rejects.toBeInstanceOf(
      CloudUnavailableError,
    );
  });

  it("maps other 4xx to generic CloudBridgeError", async () => {
    nextHandler = (_req, res) => {
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ success: false, error: "bad request" }));
    };

    const err = await client()
      .executeRpc(envelope())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudBridgeError);
    expect(err).not.toBeInstanceOf(SignatureInvalidError);
    expect(err).not.toBeInstanceOf(NonceReplayError);
    expect((err as CloudBridgeError).status).toBe(400);
  });
});
