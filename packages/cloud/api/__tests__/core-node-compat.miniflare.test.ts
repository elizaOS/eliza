/** Verify the ordinary Node distribution in the cloud host's Node compatibility layer. */
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";

const execute = promisify(execFile);

test("boots the built kernel and dispatches known inference without a core shim", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-node-compat-"));
  let worker: Miniflare | undefined;
  try {
    const core = fileURLToPath(
      new URL("../../../core/dist/index.js", import.meta.url),
    );
    await writeFile(
      path.join(directory, "worker.mjs"),
      `
      import { AgentRuntime, ModelType, stringToUuid } from ${JSON.stringify(core)};
      import { SQLiteDatabaseAdapter } from ${JSON.stringify(fileURLToPath(new URL("../../../../plugins/plugin-sqlite/dist/portable.js", import.meta.url)))};
      export default { async fetch() {
        const runtime = new AgentRuntime({ adapter: SQLiteDatabaseAdapter.create(":memory:", stringToUuid("Compatibility fixture")), character: { name: "Compatibility fixture", bio: [] }, logLevel: "fatal" });
        try {
          await runtime.initialize({ skipMigrations: true });
          await runtime.setCache("sqlite-proof", { complete: "stored value", count: 2n });
          let rollbackCode;
          try {
            await runtime.adapter.transaction(async (tx) => {
              await tx.setCaches([{key: "sqlite-proof", value: {complete: "uncommitted"}}]);
              throw new Error("abort fixture transaction");
            });
          } catch (error) {
            // error-policy:J1 The test response exposes the actual rollback error code.
            rollbackCode = error.code;
          }
          const stored = await runtime.getCache("sqlite-proof");
          if (stored.complete !== "stored value" || stored.count !== 2n) throw new Error("SQLite rollback lost the complete record");
          let calls = 0;
          runtime.registerModel(ModelType.TEXT_SMALL, async (_runtime, input) => {
            if (input.prompt !== "Return the fixture value.") throw new Error("Unexpected inference request");
            calls++;
            return "fixture:perfect";
          }, "fixture");
          const result = await runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Return the fixture value." });
          return Response.json({ result, calls, rollbackCode, routes: "routes" in runtime, messageService: runtime.messageService });
        } finally { await runtime.stop(); }
      }};
    `,
    );
    const config = path.join(directory, "wrangler.jsonc");
    await writeFile(
      config,
      JSON.stringify({
        name: "eliza-node-compat-fixture",
        main: "worker.mjs",
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat"],
      }),
    );
    const output = path.join(directory, "dist");
    await execute(
      "node",
      [
        fileURLToPath(
          new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
        ),
        "deploy",
        "--dry-run",
        "--config",
        config,
        "--outdir",
        output,
      ],
      { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
    );
    worker = new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: [
        {
          type: "ESModule",
          path: "worker.js",
          contents: await readFile(path.join(output, "worker.js"), "utf8"),
        },
      ],
    });
    const response = await worker.dispatchFetch("https://kernel.test/");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      result: "fixture:perfect",
      calls: 1,
      rollbackCode: "SQLITE_TRANSACTION_FAILED",
      routes: false,
      messageService: null,
    });
  } finally {
    await worker?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
