/** Validate balances over real JSON-RPC transport without signing or funded keys. */
import { once } from "node:events";
import http from "node:http";
import { expect, it } from "vitest";
import { fetchEvmNativeBalanceViaRpc } from "../read.ts";

it("reads valid balances and rejects missing or malformed provider results", async () => {
  let payload: unknown = { jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.method !== "eth_getBalance") {
      res.writeHead(400).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const rpc = `http://127.0.0.1:${address.port}`;
  try {
    expect(
      Number(
        await fetchEvmNativeBalanceViaRpc(
          rpc,
          "0x1111111111111111111111111111111111111111",
        ),
      ),
    ).toBe(1);
    for (const result of [undefined, null, 0, "", "invalid", "-1"]) {
      payload = { jsonrpc: "2.0", id: 1, result };
      await expect(
        fetchEvmNativeBalanceViaRpc(
          rpc,
          "0x1111111111111111111111111111111111111111",
        ),
      ).rejects.toMatchObject({ code: "WALLET_RPC_INVALID_BALANCE" });
    }
    payload = null;
    await expect(
      fetchEvmNativeBalanceViaRpc(
        rpc,
        "0x1111111111111111111111111111111111111111",
      ),
    ).rejects.toMatchObject({ code: "WALLET_RPC_INVALID_BALANCE" });
    payload = { jsonrpc: "2.0", id: 1, result: "0x0" };
    expect(
      Number(
        await fetchEvmNativeBalanceViaRpc(
          rpc,
          "0x1111111111111111111111111111111111111111",
        ),
      ),
    ).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
