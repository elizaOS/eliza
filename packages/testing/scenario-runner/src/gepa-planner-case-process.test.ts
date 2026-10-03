/** Real OS-process isolation and planner/model dispatch; loopback model output is deterministic, never live quality evidence. */

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { plannerTemplate } from "../../../../plugins/plugin-assistant/src/prompts/planner.ts";
import { gepaHash } from "./gepa-planner-case.ts";
import { runIsolatedGepaPlannerCase } from "./gepa-planner-case-process.ts";

// Fail promptly if a worker exits before reaching the request synchronization point.
// Attaching this rejection handler immediately also prevents an unhandled rejection
// while the test is waiting for the loopback server.
async function waitForActiveRequest(
  active: Promise<void>,
  run: Promise<unknown>,
) {
  await Promise.race([
    active,
    run.then(() => {
      throw new Error("Worker completed before its request became active");
    }),
  ]);
}

const requests: unknown[] = [];
let endpoint: string;
let hangingRequest: ((response: ServerResponse) => void) | undefined;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push(body);
  if (body.model === "hanging") {
    hangingRequest?.(response);
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify(
      body.model === "invalid-response"
        ? { missing: "text" }
        : {
            text: "Ready.",
            usage: { promptTokens: 12, completionTokens: 2, totalTokens: 14 },
          },
    ),
  );
});
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture listener has no port");
  endpoint = `http://127.0.0.1:${address.port}/model`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
function input(sentinel: string, model = "fixture-planner") {
  const generation = { temperature: 0, maxTokens: 128 };
  const target = {
    provider: "deterministic-fixture",
    model,
    endpoint,
    generationConfigSha256: gepaHash(generation),
    runtimeRevision: revision,
  };
  return {
    version: 1,
    caseId: sentinel,
    scenarioFamily: "read-only-planner",
    variant: sentinel,
    dynamic: {
      userRequest: `literal $& {candidate} ${sentinel} ${"full context ".repeat(2000)}`,
      history: [{ text: "oldest retained turn" }],
      definitions: [
        { name: "unavailable-action", description: "No effects admitted" },
      ],
      toolResults: [{ error: "previous failure" }],
      viewCatalog: [{ id: "home" }],
      providerContext: { timezone: "UTC", sentinel },
    },
    candidate: {
      task: "action_planner",
      optimizer: "instruction-search",
      baseline: plannerTemplate,
      prompt: `Candidate ${sentinel}: answer conversationally.`,
      score: 0,
      baselineScore: 0,
      datasetId: "fixture-only",
      datasetSize: 1,
      generatedAt: "2026-09-24T00:00:00Z",
      lineage: [],
      provenance: {
        schemaVersion: 1,
        target,
        optimizerVersion: "fixture-no-optimizer",
        optimizerConfigSha256: "a".repeat(64),
        datasetHashes: {
          train: "b".repeat(64),
          validation: "c".repeat(64),
          test: "d".repeat(64),
        },
        evaluationSha256: "e".repeat(64),
      },
    },
    target,
    generation,
    maxRequestBytes: 2_000_000,
  };
}

test("parallel candidates preserve full inputs and never activate the parent store", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gepa-parent-store-"));
  const previous = process.env.ELIZA_STATE_DIR;
  const previousKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = "parent-only-credential-sentinel";
  process.env.ELIZA_STATE_DIR = parent;
  const marker = join(parent, "unchanged.txt");
  await writeFile(marker, "parent sentinel");
  const first = input("alpha");
  const second = input("beta");
  const before = JSON.stringify([first, second]);
  try {
    const [a, b] = await Promise.all([
      runIsolatedGepaPlannerCase(first),
      runIsolatedGepaPlannerCase(second),
    ]);
    expect(a.processId).not.toBe(b.processId);
    const checkout = fileURLToPath(new URL("../../../..", import.meta.url));
    expect(a.sourceProof.checkout).toBe(checkout.replace(/\/$/, ""));
    expect(a.sourceProof.revision).toBe(revision);
    expect(a.sourceProof.entries.length).toBeGreaterThan(6);
    for (const source of a.sourceProof.entries) {
      expect(source.path.startsWith(checkout)).toBe(true);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(a.sourceProof.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          importer: `${checkout}packages/testing/src/pglite-runtime.ts`,
          specifier: "@elizaos/plugin-sql",
          path: `${checkout}plugins/plugin-sql/src/index.ts`,
        }),
        expect.objectContaining({
          importer: `${checkout}plugins/plugin-sql/src/index.ts`,
          specifier: "@elizaos/core",
          path: `${checkout}packages/core/src/index.ts`,
        }),
      ]),
    );
    expect(a.stateRoot).not.toBe(b.stateRoot);
    expect(a.input.dynamic).toEqual(first.dynamic);
    expect(b.input.dynamic).toEqual(second.dynamic);
    expect(a.wire).toHaveLength(1);
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]).toMatchObject({
      provider: "deterministic-fixture",
      model: "fixture-planner",
      inputTokens: 12,
      outputTokens: 2,
      cachedTokens: null,
    });
    expect(a.calls[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(a.inheritedProviderCredentials).toBe(false);
    expect(JSON.stringify(a)).not.toContain("parent-only-credential-sentinel");
    expect(process.env.CEREBRAS_API_KEY).toBe(
      "parent-only-credential-sentinel",
    );
    expect(a.activated).toBe(false);
    expect(b.activated).toBe(false);
    expect(a.result.status).toBe("finished");
    expect(a.qualification).toBe("deterministic-planner-boundary-only");
    expect(JSON.stringify([first, second])).toBe(before);
    expect(process.env.ELIZA_STATE_DIR).toBe(parent);
    expect(await readFile(marker, "utf8")).toBe("parent sentinel");
    expect(await readdir(parent)).toEqual(["unchanged.txt"]);
    await expect(readdir(a.stateRoot)).rejects.toThrow();
  } finally {
    if (previousKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = previousKey;
    if (previous === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previous;
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

test("rejects incomplete responses and full requests over the admitted limit", async () => {
  await expect(
    runIsolatedGepaPlannerCase(input("incomplete", "invalid-response")),
  ).rejects.toThrow("inconclusive");
  const tooLarge = { ...input("oversize"), maxRequestBytes: 1 };
  const count = requests.length;
  await expect(runIsolatedGepaPlannerCase(tooLarge)).rejects.toThrow(
    "declared fixture limit",
  );
  expect(requests).toHaveLength(count);
}, 60_000);

test("rejects mismatched config, incomplete dynamic cases and remote transport before spawning", async () => {
  const row = input("invalid");
  await expect(
    runIsolatedGepaPlannerCase({
      ...row,
      generation: { ...row.generation, maxTokens: 1 },
    }),
  ).rejects.toThrow("configuration");
  await expect(
    runIsolatedGepaPlannerCase({
      ...row,
      dynamic: { userRequest: "missing full context" },
    }),
  ).rejects.toThrow();
  await expect(
    runIsolatedGepaPlannerCase({
      ...row,
      target: {
        ...row.target,
        endpoint: "https://api.cerebras.ai/v1/chat/completions",
      },
    }),
  ).rejects.toThrow("loopback");
});

test("a timed-out worker is inconclusive and cannot leak state into the next case", async () => {
  await expect(
    runIsolatedGepaPlannerCase(input("terminated"), 1),
  ).rejects.toThrow("timeout");
  const next = await runIsolatedGepaPlannerCase(input("after-termination"));
  expect(next.input.caseId).toBe("after-termination");
  expect(next.activated).toBe(false);
}, 60_000);

test("documented CLI writes a complete candidate-only evidence artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gepa-cli-input-"));
  let artifactPath: string | undefined;
  try {
    const casePath = join(directory, "case.json");
    const row = input("cli-case");
    await writeFile(casePath, JSON.stringify(row));
    const child = spawn(
      "bun",
      [
        "--conditions=eliza-source",
        fileURLToPath(
          new URL("./gepa-planner-case-process.ts", import.meta.url),
        ),
        casePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, stderr).toBe(0);
    artifactPath = stdout.trim();
    expect(artifactPath).toContain("test-results/gepa-case-worker/");
    const evidence = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(evidence.input.dynamic).toEqual(row.dynamic);
    expect(evidence.activated).toBe(false);
    expect(evidence.wire).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (artifactPath) await rm(artifactPath, { force: true });
  }
}, 60_000);

test("rejects dirty runtime source before dispatch and changes during execution", async () => {
  const path = new URL(
    "../../../../plugins/plugin-assistant/src/prompts/planner.ts",
    import.meta.url,
  );
  const original = await readFile(path, "utf8");
  const controller = new AbortController();
  let run: Promise<unknown> | undefined;
  try {
    await writeFile(path, `${original}\n// Dirty-source rejection fixture.\n`);
    const count = requests.length;
    await expect(
      runIsolatedGepaPlannerCase(input("dirty-before")),
    ).rejects.toThrow("clean committed");
    expect(requests).toHaveLength(count);
    await writeFile(path, original);
    let response!: ServerResponse;
    const active = new Promise<void>((resolve) => {
      hangingRequest = (value) => {
        response = value;
        resolve();
      };
    });
    run = runIsolatedGepaPlannerCase(input("dirty-during", "hanging"), 30_000, {
      signal: controller.signal,
    });
    await waitForActiveRequest(active, run);
    await writeFile(
      path,
      `${original}\n// Concurrent source change fixture.\n`,
    );
    response.end(JSON.stringify({ text: "Ready." }));
    await expect(run).rejects.toThrow("clean committed");
  } finally {
    controller.abort();
    await run?.catch(() => {});
    hangingRequest = undefined;
    await writeFile(path, original);
  }
}, 60_000);

test("caller cancellation closes an active HTTP request and reaps worker before state removal", async () => {
  const controller = new AbortController();
  let worker!: { pid: number; stateRoot: string };
  let response!: ServerResponse;
  const active = new Promise<void>((resolve) => {
    hangingRequest = (value) => {
      response = value;
      resolve();
    };
  });
  const run = runIsolatedGepaPlannerCase(
    input("cancel-active", "hanging"),
    30_000,
    {
      signal: controller.signal,
      onWorkerStarted: (value) => {
        worker = value;
      },
    },
  );
  try {
    await waitForActiveRequest(active, run);
    const disconnected = once(response, "close");
    controller.abort(new Error("caller canceled"));
    await expect(run).rejects.toThrow("caller canceled");
    await disconnected;
    expect(() => process.kill(worker.pid, 0)).toThrow();
    await expect(readdir(worker.stateRoot)).rejects.toThrow();
  } finally {
    controller.abort();
    hangingRequest = undefined;
    await run.catch(() => {});
  }
}, 60_000);

test.each(["SIGINT", "SIGTERM"] as const)(
  "CLI %s cancels active request, reaps child and removes state",
  async (signal) => {
    const directory = await mkdtemp(join(tmpdir(), "gepa-cli-cancel-"));
    const path = join(directory, "case.json");
    await writeFile(path, JSON.stringify(input(`cli-${signal}`, "hanging")));
    let response!: ServerResponse;
    const active = new Promise<void>((resolve) => {
      hangingRequest = (value) => {
        response = value;
        resolve();
      };
    });
    const child = spawn(
      "bun",
      [
        "--conditions=eliza-source",
        fileURLToPath(
          new URL("./gepa-planner-case-process.ts", import.meta.url),
        ),
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.resume();
    const exited = once(child, "close");
    try {
      await waitForActiveRequest(active, exited);
      const disconnected = once(response, "close");
      const line = stderr
        .split("\n")
        .find((value) => value.startsWith('{"worker":'));
      expect(line).toBeDefined();
      const { worker } = JSON.parse(line ?? "{}");
      child.kill(signal);
      const [code] = await exited;
      expect(code).not.toBe(0);
      await disconnected;
      expect(() => process.kill(worker.pid, 0)).toThrow();
      await expect(readdir(worker.stateRoot)).rejects.toThrow();
    } finally {
      hangingRequest = undefined;
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
