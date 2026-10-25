/**
 * POST /api/database/test with a connectionString that is not a URL: the
 * validation failure reported to the admin must name the malformed connection
 * string, not claim that the credentials carry no host. A credential set that
 * genuinely lacks a host keeps its existing "could not determine host" answer.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { handleDatabaseRoute } from "../src/api/database.ts";

async function postTestConnection(payload: unknown): Promise<{
  status: number;
  error: string;
}> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleDatabaseRoute(req, res, null, pathname);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/database/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { error?: string };
    return { status: response.status, error: body.error ?? "" };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("names an unparseable Postgres connection string instead of reporting a missing host", async () => {
  // libpq keyword form, not accepted by the URL parser used for host checks.
  const result = await postTestConnection({
    connectionString: "host=127.0.0.1 port=5432 dbname=eliza",
  });
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/invalid postgresql connection string/i);
  expect(result.error).not.toMatch(/could not determine target host/i);
});

it("still reports a missing host when the credentials carry none", async () => {
  const result = await postTestConnection({});
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/could not determine target host/i);
});
