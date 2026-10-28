import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

describe("Cloudflare monthly download quotas", () => {
  let worker: Miniflare;
  let directory: string;
  let script: string;
  const start = (binding = true, backend = "cloudflare") =>
    new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
      bindings: {
        CLOUD_HF_EGRESS_BACKEND: backend,
        MOCK_REDIS: "1",
        NODE_ENV: "production",
      },
      durableObjects: binding
        ? { HF_EGRESS_STATE: { className: "HfEgressState", useSQLite: true } }
        : {},
      durableObjectsPersist: directory,
      outboundService: () => {
        throw new Error("Unexpected external quota I/O");
      },
    });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hf-egress-test-"));
    const build = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "../test/fixtures/hf-egress-state-worker.ts"),
      ],
      target: "browser",
      external: ["node:*", "cloudflare:*"],
      conditions: ["eliza-source"],
    });
    if (!build.success)
      throw new AggregateError(build.logs, "Quota fixture build failed");
    script = await build.outputs[0]!.text();
    worker = start();
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const call = (input: Record<string, unknown>) =>
    worker.dispatchFetch("https://quota.test/", {
      method: "POST",
      body: JSON.stringify({ month: "2026-10", ...input }),
    });
  const reserve = async (
    organization: string,
    bytes: number,
    limit: number,
    month = "2026-10",
  ) => {
    const response = await call({
      operation: "reserve",
      organization,
      bytes,
      limit,
      month,
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ allowed: boolean; usedBytes: number }>;
  };
  test("concurrent downloads share a durable limit; refunds, organizations and months remain isolated", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserve("concurrent", 10, 50)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    await worker.dispose();
    worker = start();
    expect(await reserve("concurrent", 1, 50)).toEqual({
      allowed: false,
      usedBytes: 50,
    });
    expect(
      (
        await call({
          operation: "release",
          organization: "concurrent",
          bytes: 25,
        })
      ).status,
    ).toBe(200);
    expect(await reserve("concurrent", 25, 50)).toEqual({
      allowed: true,
      usedBytes: 50,
    });
    expect(await reserve("different", 10, 50)).toEqual({
      allowed: true,
      usedBytes: 10,
    });
    expect(await reserve("concurrent", 10, 50, "2026-11")).toEqual({
      allowed: true,
      usedBytes: 10,
    });
    await call({
      operation: "release",
      organization: "concurrent",
      bytes: 1000,
    });
    expect(await reserve("concurrent", 1, 50)).toEqual({
      allowed: true,
      usedBytes: 1,
    });
  }, 60_000);
  test("quiesced transfer preserves usage, is repeatable, and seals after service including restart", async () => {
    const snapshot = {
      operation: "import",
      organization: "imported",
      bytes: 42,
      expiresAt: Date.now() + 60_000,
    };
    expect((await call(snapshot)).status).toBe(200);
    expect((await call(snapshot)).status).toBe(200);
    expect((await call({ ...snapshot, bytes: 43 })).status).toBe(503);
    expect(await reserve("imported", 8, 50)).toEqual({
      allowed: true,
      usedBytes: 50,
    });
    await worker.dispose();
    worker = start();
    expect((await call(snapshot)).status).toBe(503);
    expect(await reserve("imported", 1, 50)).toEqual({
      allowed: false,
      usedBytes: 50,
    });
  });
  test("expired transferred usage is discarded and pending expirations survive restart", async () => {
    expect(
      (
        await call({
          operation: "import",
          organization: "expired",
          bytes: 50,
          expiresAt: Date.now() - 1000,
        })
      ).status,
    ).toBe(200);
    expect(await reserve("expired", 1, 50)).toEqual({
      allowed: true,
      usedBytes: 1,
    });
    await call({
      operation: "import",
      organization: "expiring",
      bytes: 50,
      expiresAt: Date.now() + 1000,
    });
    await worker.dispose();
    await Bun.sleep(1100);
    worker = start();
    expect(await reserve("expiring", 1, 50)).toEqual({
      allowed: true,
      usedBytes: 1,
    });
  });
  test("selected Cloudflare cannot use local mock quotas when binding or selection is invalid", async () => {
    await worker.dispose();
    worker = start(false);
    const missing = await call({ organization: "missing", bytes: 1, limit: 5 });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({
      error: "HfEgressStateError",
      message: "HF_EGRESS_STATE binding is required",
    });
    await worker.dispose();
    worker = start(true, "invalid");
    expect(
      (await call({ organization: "invalid", bytes: 1, limit: 5 })).status,
    ).toBe(503);
    await worker.dispose();
    worker = start();
    await worker.ready;
  });
});
