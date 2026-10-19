/**
 * Import frame password policy: `/api/agent/import` must enforce the same
 * 12-character minimum as `PostAgentExportRequestSchema`. The frame declares
 * the password length in UTF-8 bytes, so a byte-only comparison accepts a
 * password that is far below the documented character minimum when it is
 * written in a multi-byte script.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { handleAgentTransferRoutes } from "../src/api/agent-transfer-routes.ts";

const importCalls: string[] = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleAgentTransferRoutes({
        req,
        res,
        method: req.method ?? "",
        pathname: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
        // Only `state.runtime` truthiness is read before the import helper.
        state: { runtime: { character: { name: "probe" } } },
        readJsonBody: async () => null,
        json: (response: http.ServerResponse, body: unknown) => {
          response.statusCode = 200;
          response.end(JSON.stringify(body));
        },
        error: (
          response: http.ServerResponse,
          message: string,
          status?: number,
        ) => {
          response.statusCode = status ?? 500;
          response.end(JSON.stringify({ error: message }));
        },
        exportAgent: async () => Buffer.alloc(0),
        estimateExportSize: async () => ({}),
        importAgent: async (_runtime, _file, password) => {
          importCalls.push(password);
          return { ok: true };
        },
        isAgentExportError: () => false,
      } as never);
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

/** `[4-byte big-endian password byte length][password][bundle bytes]`. */
function importFrame(password: string): Buffer {
  const encoded = Buffer.from(password, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(encoded.length, 0);
  return Buffer.concat([header, encoded, Buffer.from("bundle-bytes")]);
}

function postImport(password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/agent/import`, {
    method: "POST",
    body: new Uint8Array(importFrame(password)),
  });
}

it("rejects a multi-byte password below the 12-character minimum", async () => {
  // Four characters, twelve UTF-8 bytes: the byte length alone looks valid.
  const response = await postImport("密码密码密码密");

  expect(response.status).toBe(400);
  expect(importCalls).toHaveLength(0);
});

it("imports a bundle whose password meets the character minimum", async () => {
  const response = await postImport("correct horse battery");

  expect(response.status).toBe(200);
  expect(importCalls).toEqual(["correct horse battery"]);
});
