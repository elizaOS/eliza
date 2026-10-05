/** Executes the installed upstream engine and real isolated planner; not model-quality evidence. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseOptimizedPromptArtifact,
  plannerTemplate,
} from "@elizaos/plugin-assistant";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { testOutputPath } from "../../../../scripts/lib/test-output.ts";
import { gepaHash } from "../src/gepa-planner-case.ts";
import type * as Producer from "../src/gepa-producer.ts";

let GEPA_REVISION: typeof Producer.GEPA_REVISION;
let publishGepaCandidate: typeof Producer.publishGepaCandidate;
let runGepaPlannerOptimization: typeof Producer.runGepaPlannerOptimization;
let checkout: string;
let publicationRoot: string;
let revision: string;

const base = testOutputPath("gepa-producer");
let adapterSourcePaths: string[];
let completed: Awaited<ReturnType<typeof runGepaPlannerOptimization>>;
const python = join(
  base,
  "venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
let endpoint: string;
let hang: ((response: ServerResponse) => void) | undefined;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (hang) {
    hang(response);
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const improved = body.request.messages.some((message: { content?: string }) =>
    message.content?.includes("fixture improved instruction"),
  );
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ text: improved ? "Improved." : "Baseline." }));
});
beforeAll(async () => {
  try {
    await access(python);
  } catch {
    throw new Error(
      "Pinned GEPA environment missing: run bun run --cwd packages/benchmarks gepa:setup explicitly",
    );
  }
  checkout = await realpath(
    await mkdtemp(join(tmpdir(), "gepa-producer-source-")),
  );
  const snapshot = JSON.parse(
    execFileSync(
      "bun",
      [
        "--conditions=eliza-source",
        fileURLToPath(
          new URL(
            "../src/__fixtures__/gepa-source-snapshot.ts",
            import.meta.url,
          ),
        ),
        checkout,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000 },
    ),
  );
  revision = snapshot.revision;
  publicationRoot = join(checkout, "test-results", "gepa-producer");
  ({ GEPA_REVISION, publishGepaCandidate, runGepaPlannerOptimization } =
    await import(
      /* @vite-ignore */ pathToFileURL(
        join(
          checkout,
          "packages/benchmarks/suites/planner-optimization/src/gepa-producer.ts",
        ),
      ).href
    ));
  adapterSourcePaths = [
    join(
      checkout,
      "packages/benchmarks/suites/planner-optimization/gepa/producer.test.ts",
    ),
  ];
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture address missing");
  endpoint = `http://127.0.0.1:${address.port}/model`;
}, 180_000);
afterAll(async () => {
  if (checkout) await rm(checkout, { recursive: true, force: true });
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}, 180_000);
function row(id: string) {
  const generation = { temperature: 0, maxTokens: 64 };
  const target = {
    provider: "deterministic-fixture",
    model: "fixture",
    endpoint,
    generationConfigSha256: gepaHash(generation),
    runtimeRevision: revision,
  };
  return {
    version: 1,
    caseId: id,
    scenarioFamily: id,
    variant: `${id}-entity-time`,
    target,
    generation,
    maxRequestBytes: 2_000_000,
    dynamic: {
      userRequest: `${id} literal $& {candidate} ${"complete context ".repeat(500)}`,
      history: [{ text: `${id} oldest retained turn` }],
      definitions: [{ name: "none", description: "Read-only fixture" }],
      toolResults: [{ error: "historical failure" }],
      viewCatalog: [{ id: "home" }],
      providerContext: { timezone: "UTC", sentinel: id },
    },
    candidate: {
      task: "action_planner",
      optimizer: "gepa",
      baseline: plannerTemplate,
      prompt: plannerTemplate,
      score: 0,
      baselineScore: 0,
      datasetId: "fixture",
      datasetSize: 3,
      generatedAt: "2026-09-24T00:00:00Z",
      lineage: [],
      provenance: {
        schemaVersion: 1,
        target,
        optimizerVersion: `gepa@${GEPA_REVISION}`,
        optimizerConfigSha256: "a".repeat(64),
        datasetHashes: {
          train: "b".repeat(64),
          validation: "c".repeat(64),
          test: "d".repeat(64),
        },
        evaluationSha256: "e".repeat(64),
      },
    },
  };
}
function manifest() {
  return {
    objective: "Exercise fixture reflection and selection, not quality",
    maxEvals: 6,
    maxProposals: 1,
    seed: 0,
    reflectionIdentity: "deterministic-callable-fixture",
    evaluatorIdentity: "fixture-final-message-control",
    train: [row("TRAIN_CONTEXT")],
    validation: [row("VALIDATION_CONTEXT")],
    test: [row("UNTOUCHED_TEST")],
  };
}
const evaluate = async (evidence: {
  result: { status: string; finalMessage?: string };
}) => ({
  score:
    evidence.result.status === "finished" &&
    evidence.result.finalMessage === "Improved."
      ? 1
      : 0,
  diagnostics: {
    requirement:
      "Fixture control expects Improved.; not a real-world quality rubric",
  },
});
const reflect = async () => "```\nfixture improved instruction\n```";

test("real upstream reflection, Pareto selection and held-out evaluation emit a canonical inactive artifact", async () => {
  const input = manifest();
  const before = gepaHash(input);
  const result = await runGepaPlannerOptimization(input, {
    python,
    adapterSourcePaths,
    caseTimeoutMs: 90_000,
    evaluate,
    reflect,
  });
  completed = result;
  await writeFile(
    join(base, "engine-execution-evidence.json"),
    JSON.stringify(result, null, 2),
  );
  expect(gepaHash(input)).toBe(before);
  expect(result.activated).toBe(false);
  expect(result.caseTimeoutMs).toBe(90_000);
  expect(parseOptimizedPromptArtifact(result.artifact)).toEqual(
    result.artifact,
  );
  expect(result.artifact.optimizer).toBe("gepa");
  expect(result.artifact.provenance?.optimizerVersion).toBe(
    `gepa@${GEPA_REVISION}`,
  );
  expect(result.artifact.score).toBe(1);
  expect(result.artifact.baselineScore).toBe(0);
  expect(result.artifact.promotionDecision?.promote).toBe(false);
  expect(result.engineResult.candidates).toHaveLength(2);
  expect(result.engineResult.bestIndex).toBe(1);
  expect(result.engineResult.totalEvaluations).toBe(4);
  expect(result.evaluations).toHaveLength(6);
  expect(result.engineLog).toContain("pareto");
  expect(result.reflections).toHaveLength(1);
  const reflection = JSON.stringify(result.reflections[0].prompt);
  expect(reflection).toContain("TRAIN_CONTEXT");
  expect(reflection).toContain("oldest retained turn");
  expect(reflection).toContain(input.train[0].dynamic.userRequest);
  expect(reflection).not.toContain("UNTOUCHED_TEST");
  expect(reflection).not.toContain("VALIDATION_CONTEXT");
  expect(result.reflections[0].inputTokens).toBeNull();
  expect(
    result.evaluations.every((entry) =>
      entry.evidence.calls.every(
        (call: { inputTokens: null }) => call.inputTokens === null,
      ),
    ),
  ).toBe(true);
  expect(
    result.evaluations.filter((entry) => entry.caseId === "UNTOUCHED_TEST"),
  ).toHaveLength(2);
  for (const entry of result.evaluations)
    expect(() => process.kill(entry.evidence.processId, 0)).toThrow();
}, 360_000);

test("split overlap fails before execution", async () => {
  const input = manifest();
  input.test[0].scenarioFamily = input.train[0].scenarioFamily;
  await expect(
    runGepaPlannerOptimization(input, {
      python,
      adapterSourcePaths,
      caseTimeoutMs: 90_000,
      evaluate,
      reflect,
    }),
  ).rejects.toThrow("must not cross");
});

test("scorer infrastructure failure propagates without producing an artifact", async () => {
  let engine!: { pid: number; stateRoot: string };
  await expect(
    runGepaPlannerOptimization(manifest(), {
      python,
      adapterSourcePaths,
      caseTimeoutMs: 90_000,
      reflect,
      evaluate: async () => {
        throw new Error("scoring infrastructure offline");
      },
      onEngineStarted: (value) => {
        engine = value;
      },
    }),
  ).rejects.toThrow("scoring infrastructure offline");
  expect(() => process.kill(engine.pid, 0)).toThrow();
  await expect(readdir(engine.stateRoot)).rejects.toThrow();
});

test("cancellation during a real worker HTTP request reaps engine and worker", async () => {
  let engine!: { pid: number; stateRoot: string };
  let worker!: { pid: number; stateRoot: string };
  let response!: ServerResponse;
  const active = new Promise<void>((done) => {
    hang = (value) => {
      response = value;
      done();
    };
  });
  const controller = new AbortController();
  const run = runGepaPlannerOptimization(manifest(), {
    python,
    adapterSourcePaths,
    caseTimeoutMs: 90_000,
    evaluate,
    reflect,
    signal: controller.signal,
    onEngineStarted: (value) => {
      engine = value;
    },
    onCaseWorkerStarted: (value) => {
      worker = value;
    },
  });
  try {
    await Promise.race([
      active,
      run.then(() => {
        throw new Error("GEPA run completed before the fixture request");
      }),
    ]);
    const disconnected = once(response, "close");
    controller.abort(new Error("caller stop"));
    await expect(run).rejects.toThrow("caller stop");
    await disconnected;
    for (const processInfo of [engine, worker]) {
      expect(() => process.kill(processInfo.pid, 0)).toThrow();
      await expect(readdir(processInfo.stateRoot)).rejects.toThrow();
    }
  } finally {
    hang = undefined;
    controller.abort();
    await run.catch(() => {});
  }
});

test("last evaluator mutation of producer source invalidates the entire run", async () => {
  const path = join(
    checkout,
    "packages/benchmarks/suites/planner-optimization/gepa/engine.py",
  );
  const original = await readFile(path, "utf8");
  try {
    const outcome = await runGepaPlannerOptimization(manifest(), {
      python,
      adapterSourcePaths,
      caseTimeoutMs: 90_000,
      reflect,
      evaluate: async (evidence, input) => {
        const score = await evaluate(evidence);
        if (
          input.caseId === "UNTOUCHED_TEST" &&
          evidence.input.candidate.prompt === "fixture improved instruction"
        )
          await writeFile(
            path,
            `${original}\n# Last evaluator source mutation fixture.\n`,
          );
        return score;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome, String(outcome)).toMatchObject({
      code: "GEPA_PRODUCER_SOURCE_INVALID",
    });
  } finally {
    await writeFile(path, original);
  }
}, 360_000);

test("publication rejects an artifact detached from its observed evidence", async () => {
  const tampered = structuredClone(completed);
  tampered.artifact.prompt = "Unobserved replacement instruction";
  await expect(publishGepaCandidate(tampered)).rejects.toMatchObject({
    code: "GEPA_PRODUCER_ARTIFACT_INVALID",
  });
  const changedReceipt = structuredClone(completed);
  changedReceipt.evaluations[0].score = 0.875;
  await expect(publishGepaCandidate(changedReceipt)).rejects.toMatchObject({
    code: "GEPA_PRODUCER_ARTIFACT_INVALID",
  });
  expect(
    (await readdir(publicationRoot)).filter((name) =>
      name.startsWith(".publish-"),
    ),
  ).toEqual([]);
});

test("publication abort after staging leaves no candidate or staging directory", async () => {
  expect(completed).toBeDefined();
  const controller = new AbortController();
  const checkAbort = controller.signal.throwIfAborted.bind(controller.signal);
  const cancellation = vi
    .spyOn(controller.signal, "throwIfAborted")
    .mockImplementation(() => {
      if (
        readdirSync(publicationRoot).some((name) =>
          name.startsWith(".publish-"),
        )
      )
        controller.abort(new Error("publication canceled"));
      checkAbort();
    });
  try {
    await expect(
      publishGepaCandidate(completed, controller.signal),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    await expect(
      access(
        join(
          publicationRoot,
          completed.artifact.provenance?.evaluationSha256 ?? "invalid",
        ),
      ),
    ).rejects.toThrow();
    expect(
      (await readdir(publicationRoot)).filter((name) =>
        name.startsWith(".publish-"),
      ),
    ).toEqual([]);
  } finally {
    cancellation.mockRestore();
  }
});

test("failed atomic publication preserves existing files and removes staging", async () => {
  const destination = join(
    publicationRoot,
    completed.artifact.provenance?.evaluationSha256 ?? "invalid",
  );
  await mkdir(destination);
  await writeFile(join(destination, "existing.txt"), "preserve");
  try {
    await expect(publishGepaCandidate(completed)).rejects.toMatchObject({
      code: "GEPA_PRODUCER_PUBLICATION_FAILED",
    });
    expect(await readdir(destination)).toEqual(["existing.txt"]);
    expect(
      (await readdir(publicationRoot)).filter((name) =>
        name.startsWith(".publish-"),
      ),
    ).toEqual([]);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
  const published = await publishGepaCandidate(completed);
  expect(
    parseOptimizedPromptArtifact(JSON.parse(await readFile(published, "utf8"))),
  ).toEqual(completed.artifact);
  expect(
    JSON.parse(await readFile(join(destination, "evidence.json"), "utf8"))
      .activated,
  ).toBe(false);
});

test("invalid case budgets fail before optimizer or worker startup", async () => {
  for (const caseTimeoutMs of [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const onEngineStarted = vi.fn();
    await expect(
      runGepaPlannerOptimization(manifest(), {
        python,
        adapterSourcePaths,
        evaluate,
        reflect,
        caseTimeoutMs,
        onEngineStarted,
      }),
    ).rejects.toThrow("Positive case timeout required");
    expect(onEngineStarted).not.toHaveBeenCalled();
  }
});
