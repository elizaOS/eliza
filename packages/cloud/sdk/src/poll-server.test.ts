/** Verifies total SDK polling deadlines and cancellation with real localhost HTTP. */
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ElizaCloudClient } from "./client.js";

let baseUrl: string;
const requests = new Map<string, number>();
const server = createServer((req, res) => {
  const id = req.url?.split("/").at(-1) ?? "";
  const count = (requests.get(id) ?? 0) + 1;
  requests.set(id, count);
  if (id.startsWith("headers")) return;
  res.setHeader("content-type", "application/json");
  if (id.startsWith("body")) {
    res.write('{"status":');
    return;
  }
  const login = req.url?.startsWith("/api/auth/");
  const status =
    id.startsWith("complete") && count > 1
      ? login
        ? "authenticated"
        : "completed"
      : id.startsWith("fail")
        ? login
          ? "expired"
          : "failed"
        : "pending";
  res.end(
    JSON.stringify({
      id,
      status,
      ...(status === "completed" ? { result: { complete: "result" } } : {}),
      ...(status === "authenticated"
        ? { apiKey: "local-fixture-key", userId: "user" }
        : {}),
    }),
  );
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});

for (const mode of ["job", "login"] as const) {
  describe(`real HTTP ${mode} polling`, () => {
    const poll = (
      id: string,
      options: { timeoutMs?: number; intervalMs?: number },
    ) => {
      const client = new ElizaCloudClient({ baseUrl });
      return mode === "job"
        ? client.pollJob(id, options)
        : client.waitForCliLogin(id, options);
    };
    it.each(["headers", "body", "pending"])(
      "bounds %s stalls and long intervals by the total timeout",
      async (phase) => {
        const id = `${phase}-${mode}`;
        const started = performance.now();
        await expect(
          poll(id, { timeoutMs: 80, intervalMs: 2_000 }),
        ).rejects.toThrow("Timed out waiting for Eliza Cloud");
        expect(performance.now() - started).toBeLessThan(800);
        expect(requests.get(id)).toBe(1);
      },
    );
    it("preserves terminal results through repeated requests", async () => {
      const result = await poll(`complete-${mode}`, {
        timeoutMs: 2_000,
        intervalMs: 1,
      });
      if (mode === "job")
        expect(result).toMatchObject({
          status: "completed",
          result: { complete: "result" },
        });
      else
        expect(result).toMatchObject({
          status: "authenticated",
          apiKey: "local-fixture-key",
        });
    });
    it("preserves failed or expired terminal outcomes", async () => {
      if (mode === "job")
        await expect(poll("fail-job", {})).resolves.toMatchObject({
          status: "failed",
        });
      else
        await expect(poll("fail-login", {})).rejects.toThrow("sign-in expired");
    });
    it.each([-1, NaN, Infinity, 0.5, 2_147_483_648])(
      "rejects invalid timer options before sending HTTP",
      async (value) => {
        await expect(
          poll(`invalid-${mode}`, { timeoutMs: value }),
        ).rejects.toBeInstanceOf(RangeError);
        await expect(
          poll(`invalid-${mode}`, { intervalMs: value }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(requests.has(`invalid-${mode}`)).toBe(false);
      },
    );
    it("expires a zero timeout before sending HTTP", async () => {
      await expect(poll(`zero-${mode}`, { timeoutMs: 0 })).rejects.toThrow(
        "Timed out",
      );
      expect(requests.has(`zero-${mode}`)).toBe(false);
    });
  });
}

describe("login cancellation", () => {
  it.each(["headers", "body", "pending"])(
    "interrupts %s with the existing cancellation message",
    async (phase) => {
      const controller = new AbortController();
      const reason = new Error("caller stopped");
      const timer = setTimeout(() => controller.abort(reason), 80);
      const started = performance.now();
      try {
        await expect(
          new ElizaCloudClient({ baseUrl }).waitForCliLogin(`${phase}-cancel`, {
            signal: controller.signal,
            timeoutMs: 2_000,
            intervalMs: 2_000,
          }),
        ).rejects.toMatchObject({
          message: "Eliza Cloud sign-in was cancelled",
          cause: reason,
        });
        expect(performance.now() - started).toBeLessThan(800);
      } finally {
        clearTimeout(timer);
      }
    },
  );
});
