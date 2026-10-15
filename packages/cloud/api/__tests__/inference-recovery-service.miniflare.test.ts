/** Real cross-Worker RPC transport; financial database recovery is qualified separately. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

test("private recovery callback transport awaits publication and retains a lease on failure", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "inference-recovery-rpc-"),
  );
  const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
  const built = await Bun.build({
    entrypoints: [
      path.join(fixtures, "inference-recovery-rpc-client.ts"),
      path.join(fixtures, "inference-recovery-rpc-accounting-fixture.ts"),
    ],
    outdir: directory,
    target: "node",
    external: ["cloudflare:workers", "node:async_hooks"],
    conditions: ["eliza-source"],
  });
  assert(built.success, built.logs.map(String).join("\n"));
  const runtime = new Miniflare({
    workers: [
      {
        name: "client",
        modulesRoot: directory,
        modules: true,
        scriptPath: path.join(directory, "inference-recovery-rpc-client.js"),
        compatibilityDate: "2026-04-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { TEST: { className: "TestClient", useSQLite: true } },
        serviceBindings: {
          INFERENCE_RECOVERY_SERVICE: {
            name: "recovery",
            entrypoint: "RecoveryFixture",
          },
        },
      },
      {
        name: "recovery",
        modulesRoot: directory,
        modules: true,
        scriptPath: path.join(
          directory,
          "inference-recovery-rpc-accounting-fixture.js",
        ),
        compatibilityDate: "2026-04-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    ],
  });
  try {
    const namespace = await runtime.getDurableObjectNamespace("TEST", "client");
    const stub = namespace.get(namespace.idFromName("owned-recovery-rpc"));
    for (const requestPath of ["/ok", "/ok", "/fail"]) {
      const response = await stub.fetch(`https://owned.invalid${requestPath}`);
      const result = (await response.json()) as {
        calls: string[];
        lease: boolean;
        published: boolean;
      };
      assert.deepEqual(result.calls, ["lower", "publish"]);
      assert.equal(result.lease, requestPath === "/fail");
      assert.equal(result.published, true);
    }
    const recovery = await runtime.getWorker("recovery");
    assert.equal(
      (await recovery.fetch("https://owned.invalid/recover")).status,
      404,
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
