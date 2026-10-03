/** Genuine upstream optimization with caller-owned scoring/reflection, never activation. */
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { parseOptimizedPromptArtifact } from "../../../../plugins/plugin-assistant/src/services/optimized-prompt.ts";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import {
  type GepaPlannerCase,
  gepaHash,
  parseGepaPlannerCase,
} from "./gepa-planner-case.ts";
import { runIsolatedGepaPlannerCase } from "./gepa-planner-case-process.ts";
import type { proveGepaSources } from "./gepa-source-proof.ts";

export const GEPA_REVISION = "d771eb21b5dd3228bc3f567293d2ccfc423fc900";
const manifestSchema = z
  .object({
    objective: z.string().min(1),
    maxEvals: z.number().int().positive(),
    maxProposals: z.number().int().positive(),
    seed: z.number().int().nonnegative(),
    reflectionIdentity: z.string().min(1),
    evaluatorIdentity: z.string().min(1),
    train: z.array(z.unknown()).min(1),
    validation: z.array(z.unknown()).min(1),
    test: z.array(z.unknown()).min(1),
  })
  .strict();
const scoreSchema = z
  .object({ score: z.number().finite().min(0).max(1), diagnostics: z.json() })
  .strict();
export interface GepaProducerAdapter {
  evaluate(
    evidence: Awaited<ReturnType<typeof runIsolatedGepaPlannerCase>>,
    row: GepaPlannerCase,
    signal: AbortSignal,
  ): Promise<z.infer<typeof scoreSchema>>;
  reflect(prompt: unknown, signal: AbortSignal): Promise<string>;
}
async function executeGepaPlannerOptimization(
  value: unknown,
  options: GepaProducerAdapter & {
    python: string;
    adapterSourcePaths: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    onEngineStarted?: (process: { pid: number; stateRoot: string }) => void;
    onCaseWorkerStarted?: (process: { pid: number; stateRoot: string }) => void;
  },
) {
  z.string().min(1).parse(options.python);
  const manifest = manifestSchema.parse(value);
  const partitions = {
    train: manifest.train.map(parseGepaPlannerCase),
    validation: manifest.validation.map(parseGepaPlannerCase),
    test: manifest.test.map(parseGepaPlannerCase),
  };
  const rows = new Map<string, GepaPlannerCase>();
  const families = new Map<string, string>();
  const baseline = partitions.train[0].candidate;
  for (const [partition, cases] of Object.entries(partitions))
    for (const row of cases) {
      if (rows.has(row.caseId))
        throw fail("Dataset case identities must be unique");
      if (
        families.has(row.scenarioFamily) &&
        families.get(row.scenarioFamily) !== partition
      )
        throw fail("Scenario families must not cross dataset partitions");
      if (
        row.candidate.baseline !== baseline.baseline ||
        gepaHash(row.target) !== gepaHash(partitions.train[0].target)
      )
        throw fail("Evaluation cases must share a baseline and target binding");
      rows.set(row.caseId, row);
      families.set(row.scenarioFamily, partition);
    }
  const inputHash = gepaHash(manifest);
  const partitionsHash = gepaHash(partitions);
  const datasetHashes = {
    train: gepaHash(partitions.train),
    validation: gepaHash(partitions.validation),
    test: gepaHash(partitions.test),
  };
  const adapterSourcePaths = await Promise.all(
    z
      .array(z.string().min(1))
      .min(1)
      .parse(options.adapterSourcePaths)
      .map((path) => realpath(path)),
  );
  const producerSourceProof = await readProducerSourceProof(
    partitions.train[0].target.runtimeRevision,
    adapterSourcePaths,
    options.signal,
  );
  const optimizerConfigSha256 = gepaHash({
    ...manifest,
    train: datasetHashes.train,
    validation: datasetHashes.validation,
    test: datasetHashes.test,
    upstream: GEPA_REVISION,
    producerSourceProofSha256: gepaHash(producerSourceProof),
  });
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      options.signal?.reason ??
        fail("GEPA optimization canceled", "GEPA_PRODUCER_CANCELED"),
    );
  options.signal?.throwIfAborted();
  const timeout = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw fail("Positive optimizer timeout required");
  const base = testOutputPath("gepa-producer");
  await mkdir(base, { recursive: true });
  const temporary = await mkdtemp(join(base, "engine-"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        fail("GEPA optimization timeout", "GEPA_PRODUCER_CANCELED"),
      ),
    timeout,
  );
  const cancellable = async <T>(promise: Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    let onAbort!: () => void;
    const canceled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, canceled]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
  const evaluations: Array<{
    caseId: string;
    instruction: string;
    score: number;
    diagnostics: unknown;
    evidence: Awaited<ReturnType<typeof runIsolatedGepaPlannerCase>>;
  }> = [];
  const reflections: Array<{
    prompt: unknown;
    response: string;
    latencyMs: number;
    inputTokens: null;
    outputTokens: null;
    cachedTokens: null;
  }> = [];
  let stderr = "";
  const child = spawn(
    options.python,
    [fileURLToPath(new URL("../gepa/engine.py", import.meta.url))],
    {
      cwd: temporary,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: temporary,
        TMPDIR: temporary,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let spawnError: Error | undefined;
  let closed = false;
  const exited = new Promise<number | null>((done) => {
    child.on("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      closed = true;
      done(code);
    });
  });
  const kill = () => {
    if (!closed) child.kill("SIGKILL");
  };
  controller.signal.addEventListener("abort", kill, { once: true });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.on("error", (error) => {
    controller.abort(error);
  });
  let result: unknown;
  try {
    if (child.pid)
      options.onEngineStarted?.({ pid: child.pid, stateRoot: temporary });
    if (options.signal?.aborted) abort();
    controller.signal.throwIfAborted();
    child.stdin.write(
      `${JSON.stringify({ baseline: baseline.baseline, objective: manifest.objective, maxEvals: manifest.maxEvals, maxProposals: manifest.maxProposals, seed: manifest.seed, outputDir: temporary, ...Object.fromEntries(Object.entries(partitions).map(([key, cases]) => [key, cases.map((row) => ({ id: row.caseId }))])) })}\n`,
    );
    for await (const line of createInterface({ input: child.stdout })) {
      controller.signal.throwIfAborted();
      const message = JSON.parse(line);
      if (message.method === "result") {
        result = message.payload;
        continue;
      }
      let response: unknown;
      if (message.method === "evaluate") {
        const row = rows.get(message.payload.caseId);
        const instruction = message.payload.instruction;
        if (!row || typeof instruction !== "string" || !instruction.trim())
          throw fail("Invalid upstream evaluation request");
        const candidate = parseOptimizedPromptArtifact({
          ...baseline,
          optimizer: "gepa",
          prompt: instruction,
          fewShotExamples: undefined,
          score: 0,
          baselineScore: 0,
          lineage: [],
          provenance: {
            schemaVersion: 1,
            target: row.target,
            optimizerVersion: `gepa@${GEPA_REVISION}`,
            optimizerConfigSha256,
            datasetHashes,
            evaluationSha256: gepaHash({
              inputHash,
              instruction,
              caseId: row.caseId,
            }),
          },
        });
        if (!candidate)
          throw fail("Candidate failed canonical artifact validation");
        const evidence = await runIsolatedGepaPlannerCase(
          { ...row, candidate },
          30_000,
          {
            signal: controller.signal,
            onWorkerStarted: options.onCaseWorkerStarted,
          },
        );
        const score = scoreSchema.parse(
          await cancellable(options.evaluate(evidence, row, controller.signal)),
        );
        controller.signal.throwIfAborted();
        evaluations.push({
          caseId: row.caseId,
          instruction,
          ...score,
          evidence,
        });
        response = {
          score: score.score,
          diagnostics: {
            feedback: score.diagnostics,
            input: row.dynamic,
            result: evidence.result,
            wire: evidence.wire,
            calls: evidence.calls,
          },
        };
      } else if (message.method === "reflect") {
        const started = performance.now();
        const text = await cancellable(
          options.reflect(message.payload.prompt, controller.signal),
        );
        controller.signal.throwIfAborted();
        if (typeof text !== "string" || !text.trim())
          throw fail("Reflection returned no complete instruction");
        reflections.push({
          prompt: message.payload.prompt,
          response: text,
          latencyMs: performance.now() - started,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
        });
        response = text;
      } else throw fail("Unknown upstream optimizer request");
      child.stdin.write(
        `${JSON.stringify({ id: message.id, result: response })}\n`,
      );
    }
    const code = await exited;
    controller.signal.throwIfAborted();
    if (spawnError || code !== 0)
      throw fail(
        `GEPA engine failed: ${spawnError?.message ?? code}\n${stderr}`,
      );
    const parsed = z
      .object({
        bestCandidate: z.object({ instruction: z.string().min(1) }).strict(),
        bestScore: z.number().finite().min(0).max(1),
        candidates: z.array(z.object({ instruction: z.string() }).strict()),
        validationScores: z.array(z.number().finite().min(0).max(1)),
        bestIndex: z.number().int().nonnegative(),
        totalEvaluations: z.number().int().nonnegative(),
        metadata: z.record(z.string(), z.json()),
      })
      .strict()
      .parse(result);
    if (
      gepaHash(manifest) !== inputHash ||
      gepaHash(partitions) !== partitionsHash
    )
      throw fail("Optimizer mutated immutable inputs");
    const observed = (instruction: string, cases: GepaPlannerCase[]) =>
      cases.map((row) => {
        const found = evaluations.filter(
          (evaluation) =>
            evaluation.caseId === row.caseId &&
            evaluation.instruction === instruction,
        );
        if (found.length === 0)
          throw fail("Optimizer omitted a required observed evaluation");
        return found[found.length - 1].score;
      });
    const mean = (scores: number[]) =>
      scores.reduce((sum, score) => sum + score, 0) / scores.length;
    if (
      parsed.candidates.length !== parsed.validationScores.length ||
      parsed.bestIndex >= parsed.candidates.length ||
      parsed.candidates[parsed.bestIndex].instruction !==
        parsed.bestCandidate.instruction
    )
      throw fail("Upstream candidate lineage is inconsistent");
    for (const [index, candidate] of parsed.candidates.entries()) {
      const measured = mean(
        observed(candidate.instruction, partitions.validation),
      );
      if (Math.abs(measured - parsed.validationScores[index]) > 1e-12)
        throw fail(
          "Upstream aggregate differs from observed validation scores",
        );
    }
    const baselineScore = mean(observed(baseline.baseline, partitions.test));
    const score = mean(
      observed(parsed.bestCandidate.instruction, partitions.test),
    );
    const evaluationSha256 = gepaHash({
      evaluations,
      reflections,
      result: parsed,
    });
    const artifact = parseOptimizedPromptArtifact({
      ...baseline,
      optimizer: "gepa",
      prompt: parsed.bestCandidate.instruction,
      fewShotExamples: undefined,
      score,
      baselineScore,
      datasetId: inputHash,
      datasetSize: rows.size,
      generatedAt: new Date().toISOString(),
      lineage: parsed.validationScores.map((value, index) => ({
        round: index,
        variant: index,
        score: value,
        notes: "Observed upstream validation aggregate",
      })),
      promotionDecision: {
        promote: false,
        reason:
          "Candidate only; behavior invariants and explicit promotion remain required",
      },
      provenance: {
        schemaVersion: 1,
        target: partitions.train[0].target,
        optimizerVersion: `gepa@${GEPA_REVISION}`,
        optimizerConfigSha256,
        datasetHashes,
        evaluationSha256,
      },
    });
    if (!artifact)
      throw fail("Upstream result failed canonical artifact validation");
    const finalSourceProof = await readProducerSourceProof(
      partitions.train[0].target.runtimeRevision,
      adapterSourcePaths,
      controller.signal,
    );
    if (gepaHash(finalSourceProof) !== gepaHash(producerSourceProof))
      throw fail(
        "Producer or adapter source changed during optimization",
        "GEPA_PRODUCER_SOURCE_INVALID",
      );
    controller.signal.throwIfAborted();
    return {
      artifact,
      producerSourceProof,
      adapterSourcePaths,
      adapterAttestation:
        "Trusted host asserts API callback association with these tracked sources; callable identity is not independently attested",
      manifest,
      proposerCost: null,
      targetCost: null,
      qualification: "deterministic-fixture-optimizer-execution",
      activated: false,
      inputHash,
      evaluations,
      reflections,
      engineResult: parsed,
      engineLog: stderr,
    };
  } finally {
    controller.abort();
    kill();
    await exited;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", kill);
    await rm(temporary, { recursive: true, force: true });
  }
}

function fail(
  message: string,
  code = "GEPA_PRODUCER_INCONCLUSIVE",
  cause?: unknown,
) {
  return new ElizaError(message, {
    code,
    ...(cause === undefined ? {} : { cause }),
  });
}

async function readProducerSourceProof(
  revision: string,
  adapterSources: string[],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof proveGepaSources>>> {
  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  try {
    const { stdout } = await promisify(execFile)(
      "bun",
      [
        "--conditions=eliza-source",
        "--tsconfig-override",
        join(root, "tsconfig.json"),
        fileURLToPath(new URL("./gepa-source-proof.ts", import.meta.url)),
        revision,
        fileURLToPath(new URL(import.meta.url)),
        fileURLToPath(new URL("../gepa/engine.py", import.meta.url)),
        ...adapterSources,
      ],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        signal,
        timeout: 30_000,
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    return JSON.parse(stdout);
  } catch (cause) {
    throw fail(
      "GEPA producer source verification failed",
      "GEPA_PRODUCER_SOURCE_INVALID",
      cause,
    );
  }
}

export async function runGepaPlannerOptimization(
  ...args: Parameters<typeof executeGepaPlannerOptimization>
) {
  try {
    return await executeGepaPlannerOptimization(...args);
  } catch (cause) {
    if (cause instanceof ElizaError) throw cause;
    throw fail(
      `GEPA optimization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "GEPA_PRODUCER_INCONCLUSIVE",
      cause,
    );
  }
}

/** Stage both files; publish only after cancellation and exact source proof checks. */
export async function publishGepaCandidate(
  evidence: Awaited<ReturnType<typeof runGepaPlannerOptimization>>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const root = testOutputPath("gepa-producer");
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".publish-"));
  try {
    const artifact = parseOptimizedPromptArtifact(evidence.artifact);
    if (!artifact?.provenance)
      throw fail(
        "Candidate publication requires canonical provenance",
        "GEPA_PRODUCER_ARTIFACT_INVALID",
      );
    if (
      artifact.provenance.evaluationSha256 !==
        gepaHash({
          evaluations: evidence.evaluations,
          reflections: evidence.reflections,
          result: evidence.engineResult,
        }) ||
      artifact.prompt !== evidence.engineResult.bestCandidate.instruction
    )
      throw fail(
        "Candidate does not match its recorded optimizer evidence",
        "GEPA_PRODUCER_ARTIFACT_INVALID",
      );
    await writeFile(
      join(staging, "artifact.json"),
      JSON.stringify(artifact, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(staging, "evidence.json"),
      JSON.stringify(evidence, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    const proof = await readProducerSourceProof(
      artifact.provenance.target.runtimeRevision,
      evidence.adapterSourcePaths,
      signal,
    );
    if (gepaHash(proof) !== gepaHash(evidence.producerSourceProof))
      throw fail(
        "Source changed before candidate publication",
        "GEPA_PRODUCER_SOURCE_INVALID",
      );
    signal?.throwIfAborted();
    const destination = join(root, artifact.provenance.evaluationSha256);
    await rename(staging, destination);
    return join(destination, "artifact.json");
  } catch (cause) {
    if (cause instanceof ElizaError) throw cause;
    throw fail(
      `GEPA candidate publication failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "GEPA_PRODUCER_PUBLICATION_FAILED",
      cause,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length !== 4)
    throw fail(
      "Usage: GEPA_PYTHON=/owned/venv/bin/python bun gepa-producer.ts MANIFEST.json ADAPTER.ts",
    );
  const python = process.env.GEPA_PYTHON;
  if (!python)
    throw fail(
      "GEPA_PYTHON must select the pinned isolated Python environment",
    );
  // The adapter must execute under the same source aliases used by its proof.
  const configIndex = process.execArgv.lastIndexOf("--tsconfig-override");
  const configured =
    configIndex >= 0 ? process.execArgv[configIndex + 1] : undefined;
  const expectedConfig = fileURLToPath(
    new URL("../../../../tsconfig.json", import.meta.url),
  );
  if (
    !configured ||
    (await realpath(resolve(configured))) !== (await realpath(expectedConfig))
  )
    throw fail(
      "GEPA CLI requires --tsconfig-override pointing to this checkout's root tsconfig.json",
      "GEPA_PRODUCER_SOURCE_INVALID",
    );
  const adapterPath = await realpath(resolve(process.argv[3]));
  const adapter: GepaProducerAdapter = await import(
    pathToFileURL(adapterPath).href
  );
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      fail("GEPA producer interrupted", "GEPA_PRODUCER_CANCELED"),
    );
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const evidence = await runGepaPlannerOptimization(
      JSON.parse(await readFile(process.argv[2], "utf8")),
      {
        ...adapter,
        python,
        adapterSourcePaths: [adapterPath],
        signal: controller.signal,
      },
    );
    const destination = await publishGepaCandidate(evidence, controller.signal);
    process.stdout.write(`${destination}\n`);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
