/**
 * Express REST API example smoke tests against a bound local HTTP server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "node:http";
import { app } from "./server";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Express test server did not bind to a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("OPTIONS requests return CORS headers", async () => {
  const response = await fetch(`${baseUrl}/chat`, { method: "OPTIONS" });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
});

test("POST /chat validates message body before runtime work", async () => {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "" }),
  });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    error: "Message is required and must be a string",
  });
});
