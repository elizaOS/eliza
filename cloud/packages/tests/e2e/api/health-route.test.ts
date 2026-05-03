import { expect, test } from "bun:test";

const SERVER_URL =
  process.env.TEST_BASE_URL || `http://localhost:${process.env.TEST_SERVER_PORT || "8787"}`;

test("health endpoint is reachable without authentication", async () => {
  const response = await fetch(`${SERVER_URL}/api/health`);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");

  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(typeof body.timestamp).toBe("number");
  expect(typeof body.region).toBe("string");
});
