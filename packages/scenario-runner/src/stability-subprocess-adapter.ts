/**
 * Runs one stability attempt through the concrete `runScenario` CLI path in a
 * fresh, killable process. The controller accepts only versioned synthetic
 * reset proofs and bounded, non-symlink artifacts produced by that process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  StabilityAttemptExecution,
  StabilityExecutionAdapter,
  StabilityResetProof,
} from "./stability-executor.ts";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_TRAJECTORY_BYTES = 64 * 1024 * 1024;
const MAX_TRAJECTORY_FILES = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface ScenarioCliSubprocessAdapterOptions {
  scenarioDir: string;
  resetUrl: string;
  resetToken: string;
  bunExecutable?: string;
  cliPath?: string;
  extraEnv?: Readonly<Record<string, string>>;
}

interface ResetEnvelope extends StabilityResetProof {
  target: { scenarioId: string; provider: string; model: string };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertSafePath(filePath: string, root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(filePath);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  )
    throw new Error(`artifact escaped attempt directory: ${resolved}`);
  let cursor = resolved;
  while (cursor !== resolvedRoot) {
    const info = lstatSync(cursor);
    if (info.isSymbolicLink())
      throw new Error(`artifact path contains symlink: ${cursor}`);
    cursor = path.dirname(cursor);
  }
  if (lstatSync(resolvedRoot).isSymbolicLink())
    throw new Error(`attempt directory is a symlink: ${resolvedRoot}`);
}

function readBoundedJson(
  filePath: string,
  root: string,
  maxBytes: number,
): unknown {
  assertSafePath(filePath, root);
  const info = lstatSync(filePath);
  if (!info.isFile() || info.size > maxBytes)
    throw new Error(`artifact is not a bounded regular file: ${filePath}`);
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset !== info.size)
      throw new Error(`artifact changed while reading: ${filePath}`);
    return JSON.parse(buffer.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function collectJson(root: string, attemptRoot: string): unknown[] {
  try {
    assertSafePath(root, attemptRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  const visit = (entry: string): void => {
    assertSafePath(entry, attemptRoot);
    const info = lstatSync(entry);
    if (info.isDirectory()) {
      for (const child of readdirSync(entry).sort())
        visit(path.join(entry, child));
      return;
    }
    if (!info.isFile())
      throw new Error(`trajectory entry is not regular: ${entry}`);
    if (entry.endsWith(".json")) files.push(entry);
    if (files.length > MAX_TRAJECTORY_FILES)
      throw new Error(`trajectory file count exceeds ${MAX_TRAJECTORY_FILES}`);
  };
  visit(root);
  let remaining = MAX_TRAJECTORY_BYTES;
  return files.map((file) => {
    const size = lstatSync(file).size;
    remaining -= size;
    if (remaining < 0) throw new Error("trajectory artifacts exceed 64 MiB");
    return readBoundedJson(file, attemptRoot, size);
  });
}

function numericTotal(values: readonly unknown[], key: string): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryKey === key) {
        if (typeof entryValue === "number") total += entryValue;
        else if (key === "toolCalls" && Array.isArray(entryValue))
          total += entryValue.length;
      } else visit(entryValue);
    }
  };
  for (const value of values) visit(value);
  return total;
}

function modelEnvironment(
  provider: string,
  model: string,
): Record<string, string> {
  const prefix: Record<string, string> = {
    openai: "OPENAI",
    groq: "GROQ",
    anthropic: "ANTHROPIC",
    google: "GOOGLE",
    openrouter: "OPENROUTER",
  };
  const name = prefix[provider];
  if (!name)
    throw new Error(
      `stability subprocess does not support provider '${provider}'`,
    );
  return { [`${name}_SMALL_MODEL`]: model, [`${name}_LARGE_MODEL`]: model };
}

function appendBounded(current: string, chunk: unknown, label: string): string {
  const next = current + String(chunk);
  if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT_BYTES)
    throw new Error(`${label} exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`);
  return next;
}

function parseResetEnvelope(
  value: unknown,
  expected: ResetEnvelope["target"],
): ResetEnvelope {
  if (!value || typeof value !== "object")
    throw new Error("reset endpoint returned a non-object");
  const proof = value as Partial<ResetEnvelope>;
  if (proof.schemaVersion !== "eliza.synthetic-reset-proof/v1")
    throw new Error("reset endpoint returned an unsupported schemaVersion");
  if (JSON.stringify(proof.target) !== JSON.stringify(expected))
    throw new Error("reset endpoint did not attest the requested target");
  if (!Number.isSafeInteger(proof.generation) || (proof.generation ?? 0) <= 0)
    throw new Error("reset endpoint returned an invalid generation");
  if (
    typeof proof.resetId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(proof.resetId)
  )
    throw new Error("reset endpoint returned an invalid resetId");
  for (const key of [
    "manifestHash",
    "executionStateHash",
    "providerStateHash",
    "modelRegistryHash",
  ] as const) {
    if (
      typeof proof[key] !== "string" ||
      !/^[a-f0-9]{64}$/.test(proof[key] as string)
    )
      throw new Error(`reset endpoint returned an invalid ${key}`);
  }
  return proof as ResetEnvelope;
}

export class ScenarioCliSubprocessAdapter implements StabilityExecutionAdapter {
  private readonly children = new Map<string, ChildProcess>();
  private readonly resets = new Map<string, ResetEnvelope>();

  public constructor(
    private readonly options: ScenarioCliSubprocessAdapterOptions,
  ) {
    if (!options.resetUrl || !options.resetToken)
      throw new Error(
        "resetUrl and resetToken are required for real-model stability execution",
      );
  }

  public async reset(
    input: Parameters<StabilityExecutionAdapter["reset"]>[0],
  ): Promise<StabilityResetProof> {
    const target = {
      scenarioId: input.target.scenarioId,
      provider: input.target.model.provider,
      model: input.target.model.model,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(this.options.resetUrl, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.resetToken}`,
        },
        body: JSON.stringify(target),
      });
      if (!response.ok)
        throw new Error(`mock reset failed with HTTP ${response.status}`);
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 64 * 1024)
        throw new Error("reset proof exceeds 64 KiB");
      const envelope = parseResetEnvelope(JSON.parse(raw), target);
      this.resets.set(input.outputDir, envelope);
      const { target: _target, ...proof } = envelope;
      return proof;
    } finally {
      clearTimeout(timer);
    }
  }

  public async execute(
    input: Parameters<StabilityExecutionAdapter["execute"]>[0],
  ): Promise<StabilityAttemptExecution> {
    const reset = this.resets.get(input.outputDir);
    if (!reset) throw new Error("attempt has no authoritative reset proof");
    const reportPath = path.join(input.outputDir, "matrix.json");
    const runDir = path.join(input.outputDir, "run");
    const cliPath =
      this.options.cliPath ??
      fileURLToPath(new URL("./cli.ts", import.meta.url));
    const child = spawn(
      this.options.bunExecutable ?? process.execPath,
      [
        cliPath,
        "run",
        path.resolve(this.options.scenarioDir),
        "--scenario",
        input.target.scenarioId,
        "--provider",
        input.target.model.provider,
        "--report",
        reportPath,
        "--run-dir",
        runDir,
        "--runId",
        input.attemptId,
      ],
      {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...this.options.extraEnv,
          ...modelEnvironment(
            input.target.model.provider,
            input.target.model.model,
          ),
          SCENARIO_USE_DETERMINISTIC_MODEL: "0",
          ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL: "0",
          ELIZA_SYNTHETIC_RESET_ID: reset.resetId,
          ELIZA_SYNTHETIC_RESET_GENERATION: String(reset.generation),
          ELIZA_SYNTHETIC_MANIFEST_HASH: reset.manifestHash,
          SCENARIO_TURN_TIMEOUT_MS: String(input.budgets.timeoutMs),
        },
      },
    );
    this.children.set(input.outputDir, child);
    let stdout = "";
    let stderr = "";
    let outputError: Error | null = null;
    child.stdout?.on("data", (chunk) => {
      try {
        stdout = appendBounded(stdout, chunk, "stdout");
      } catch (error) {
        outputError = error as Error;
        child.kill("SIGTERM");
      }
    });
    child.stderr?.on("data", (chunk) => {
      try {
        stderr = appendBounded(stderr, chunk, "stderr");
      } catch (error) {
        outputError = error as Error;
        child.kill("SIGTERM");
      }
    });
    const abort = (): void => this.signalChild(child, "SIGTERM");
    input.signal.addEventListener("abort", abort, { once: true });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    input.signal.removeEventListener("abort", abort);
    this.children.delete(input.outputDir);
    if (outputError) throw outputError;
    const report = readBoundedJson(
      reportPath,
      input.outputDir,
      MAX_REPORT_BYTES,
    ) as {
      providerName?: string;
      scenarios?: Array<{
        id?: string;
        status?: string;
        turns?: unknown[];
        finalChecks?: unknown[];
      }>;
    };
    const runtimeConfig = readBoundedJson(
      path.join(runDir, "stability-runtime-config.json"),
      input.outputDir,
      64 * 1024,
    ) as Record<string, unknown>;
    const runtimeConfigMatched =
      runtimeConfig.schemaVersion === "eliza.stability-runtime-config/v1" &&
      runtimeConfig.executionProfile === "simulated" &&
      runtimeConfig.providerName === input.target.model.provider &&
      runtimeConfig.smallModel === input.target.model.model &&
      runtimeConfig.largeModel === input.target.model.model &&
      runtimeConfig.resetId === reset.resetId &&
      runtimeConfig.generation === reset.generation &&
      runtimeConfig.manifestHash === reset.manifestHash &&
      runtimeConfig.mockServiceIsolation === "fresh-process-simulated-profile";
    const trajectories = collectJson(
      path.join(runDir, "trajectories"),
      input.outputDir,
    );
    const scenario = report.scenarios?.[0];
    const inputTokens = numericTotal(trajectories, "inputTokens");
    const outputTokens = numericTotal(trajectories, "outputTokens");
    const toolCalls = numericTotal(trajectories, "toolCalls");
    const providerMatched = report.providerName === input.target.model.provider;
    const modelMatched = JSON.stringify(trajectories).includes(
      input.target.model.model,
    );
    const exactScenario =
      report.scenarios?.length === 1 &&
      scenario?.id === input.target.scenarioId;
    const withinBudgets =
      inputTokens <= input.budgets.maxInputTokens &&
      outputTokens <= input.budgets.maxOutputTokens &&
      toolCalls <= input.budgets.maxToolCalls;
    const passed =
      exitCode === 0 &&
      scenario?.status === "passed" &&
      providerMatched &&
      modelMatched &&
      exactScenario &&
      runtimeConfigMatched &&
      withinBudgets;
    return {
      passed,
      inputTokens,
      outputTokens,
      toolCalls,
      finalExecutionStateHash: hash({ report, trajectories, runtimeConfig }),
      stateDiff: scenario?.turns ?? [],
      ...(passed
        ? {}
        : {
            error: !providerMatched
              ? `provider mismatch: expected ${input.target.model.provider}, received ${report.providerName ?? "missing"}`
              : !modelMatched
                ? `model ${input.target.model.model} was not observed in trajectory evidence`
                : !exactScenario
                  ? "subprocess report did not contain exactly the requested scenario"
                  : !runtimeConfigMatched
                    ? "runtime did not attest the exact reset/provider/model configuration"
                    : !withinBudgets
                      ? "attempt exceeded a configured token or tool-call budget"
                      : stderr.slice(-4_000) ||
                        stdout.slice(-4_000) ||
                        `scenario exited ${exitCode}`,
          }),
      evidence: {
        trajectory: trajectories,
        toolReceipts: scenario?.turns ?? [],
        stateTransitions: scenario?.turns ?? [],
        providerReceipts: [
          {
            provider: input.target.model.provider,
            model: input.target.model.model,
            exitCode,
            resetId: reset.resetId,
            generation: reset.generation,
            runtimeConfig,
          },
        ],
        judgeVerdicts: scenario?.finalChecks ?? [],
      },
    };
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  public async terminate(
    input: Parameters<StabilityExecutionAdapter["terminate"]>[0],
  ): Promise<void> {
    this.resets.delete(input.outputDir);
    const child = this.children.get(input.outputDir);
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null)
      this.signalChild(child, "SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("subprocess did not terminate after SIGKILL")),
          5_000,
        ),
      ),
    ]);
    this.children.delete(input.outputDir);
  }
}

/** Environment-backed factory used by the scheduled live stability workflow. */
export function createStabilityAdapter(): ScenarioCliSubprocessAdapter {
  const scenarioDir = process.env.SCENARIO_STABILITY_SCENARIO_DIR;
  const resetUrl = process.env.SCENARIO_STABILITY_RESET_URL;
  const resetToken = process.env.SCENARIO_STABILITY_RESET_TOKEN;
  if (!scenarioDir || !resetUrl || !resetToken)
    throw new Error(
      "SCENARIO_STABILITY_SCENARIO_DIR, RESET_URL, and RESET_TOKEN are required",
    );
  return new ScenarioCliSubprocessAdapter({
    scenarioDir,
    resetUrl,
    resetToken,
  });
}
