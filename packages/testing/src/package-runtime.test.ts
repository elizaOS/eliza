/** Exercises the package root in native Node with real SQLite storage and a local judge HTTP transport. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads fixtures through the package root and keeps temporary databases isolated", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { createSQLiteTestRuntime } from "@elizaos/testing";

        const agentId = "00000000-0000-4000-8000-000000000001";
        const entityId = "00000000-0000-4000-8000-000000000002";
        const options = {
          agentId,
          character: { name: "package fixture", bio: [] },
          plugins: [],
        };
        const first = createSQLiteTestRuntime(options);
        const second = createSQLiteTestRuntime(options);
        await Promise.all([first.adapter.initialize(), second.adapter.initialize()]);
        try {
          const entity = { id: entityId, agentId, names: ["persisted fixture"], metadata: {} };
          await first.adapter.createEntities([entity]);
          assert.deepEqual(await first.adapter.getEntitiesByIds([entityId]), [entity]);
          assert.deepEqual(await second.adapter.getEntitiesByIds([entityId]), []);
        } finally {
          await Promise.all([first.adapter.close(), second.adapter.close()]);
        }
      `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

it("uses the public judge transport in native Node without truncating requests", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { createServer } from "node:http";
        import { once } from "node:events";
        import { CerebrasJudge } from "@elizaos/testing";

        const requests = [];
        const server = createServer(async (request, response) => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            model: "local-judge",
            choices: [{ finish_reason: "stop", message: {
              content: JSON.stringify({ score: 0.9, reason: "complete response" }),
            } }],
          }));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const judge = new CerebrasJudge({
            baseUrl: "http://127.0.0.1:" + server.address().port,
            apiKey: "local-test",
            maxRetries: 0,
          });
          const prompt = "complete input ".repeat(10000) + "final sentinel";
          const result = await judge.judge(prompt, { systemPrompt: "judge the full input" });
          assert.deepEqual(requests[0].messages, [
            { role: "system", content: "judge the full input" },
            { role: "user", content: prompt },
          ]);
          assert.equal(result.verdict, "PASS");
          assert.equal(result.score, 0.9);
          assert.equal(result.reason, "complete response");
          assert.equal(result.identity.model, "local-judge");
        } finally {
          server.closeAllConnections();
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

it("loads package-path helpers without runtime packages or build outputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testing-paths-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.copyFileSync(
      new URL("../package.json", import.meta.url),
      path.join(dir, "package.json"),
    );
    fs.copyFileSync(
      new URL("./eliza-package-paths.ts", import.meta.url),
      path.join(dir, "src/eliza-package-paths.ts"),
    );
    fs.writeFileSync(
      path.join(dir, "probe.mjs"),
      `
      import assert from "node:assert/strict";
      import { getElizaCoreEntry, resolveModuleEntry } from "@elizaos/testing/package-paths";
      assert.equal(typeof resolveModuleEntry, "function");
      assert.equal(getElizaCoreEntry(process.cwd()), undefined);
    `,
    );
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [path.join(dir, "probe.mjs")], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("loads progressive target contracts without database fixture adapters", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "@elizaos/testing" || /^@elizaos\\/plugin-sql(?:ite)?(?:\\/|$)/.test(specifier)) {
        throw new Error("Unexpected runtime fixture import: " + specifier);
      }
      return nextResolve(specifier, context);
    }});
    const target = await import("@elizaos/testing/progressive-content-target");
    assert.equal(target.PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
      "elizaos.progressive-content.target-factory.v1");
  `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
