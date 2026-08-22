/**
 * Executes stability attempts in independent OS process groups while one
 * leased synthetic-control session owns the exact mock manifest per attempt.
 * Child processes receive only explicit mock endpoints and, for live lanes,
 * one explicit model credential; ambient service credentials are never inherited.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@elizaos/core";
import { canonicalJsonString } from "@elizaos/shared/canonical-json";
import type {
  SyntheticControlSession,
  SyntheticManifest,
} from "@elizaos/shared/synthetic-control";
import {
  assertScenarioStabilityBoundedJson,
  parseScenarioStabilityAttemptExecution,
  SCENARIO_STABILITY_MAX_ATTEMPT_JSON_BYTES,
  type ScenarioStabilityAttemptExecution,
  type ScenarioStabilityExecutionAdapter,
  type ScenarioStabilityExecutionTarget,
} from "./stability-executor.ts";
import { openScenarioSyntheticWorld } from "./synthetic-control.ts";

const MAX_STDERR_BYTES = 1024 * 1024;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;
const CREDENTIAL_NAME =
  /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|ACCESS_KEY(?:_ID)?|PRIVATE_KEY|CLIENT_SECRET|CONNECTION_STRING)$/;
const SERVICE_LOCATION_NAME = /(?:^|_)(?:URL|ENDPOINT|HOST)$/;
const INTERNAL_CONTROL_ENV = new Set([
  "ELIZA_SYNTHETIC_CONTROL_TOKEN",
  "ELIZA_SYNTHETIC_CONTROL_URL",
]);

export type ScenarioStabilityModelMode =
  | { kind: "deterministic-mock"; fixtureManifestFingerprint: string }
  | {
      kind: "real-llm";
      credentialEnv: string;
      credentialValue: string;
    };

export interface ScenarioStabilitySubprocessAdapterOptions {
  command: string;
  args(input: {
    target: ScenarioStabilityExecutionTarget;
    attemptId: string;
    outputDir: string;
  }): readonly string[];
  cwd: string;
  modelMode: ScenarioStabilityModelMode;
  syntheticControl: {
    controlUrl: string;
    controlToken: string;
    manifest: SyntheticManifest;
    timeoutMs?: number;
  };
  mockServiceUrls?: Readonly<Record<string, string>>;
  env?: Readonly<Record<string, string>>;
  openSession?: typeof openScenarioSyntheticWorld;
}

interface AttemptBoundary {
  session: SyntheticControlSession;
  child: ChildProcess | null;
  processGroupId: number | null;
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

async function ensureIsolatedDirectory(
  directory: string,
  authorityRoot: string,
): Promise<DirectoryIdentity[]> {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    throw new Error(
      "stability output directory must be an absolute canonical path",
    );
  }
  const relative = path.relative(authorityRoot, directory);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "stability output directory must remain inside the adapter cwd",
    );
  }
  const rootStat = await fs.lstat(authorityRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("stability adapter cwd must be a real directory");
  }
  const segments = relative.split(path.sep).filter(Boolean);
  let current = authorityRoot;
  const identities: DirectoryIdentity[] = [
    { path: authorityRoot, dev: rootStat.dev, ino: rootStat.ino },
  ];
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      // error-policy:J3 EEXIST is admitted only after the path is proven to be a real directory below.
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
      )
        throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `stability output path traverses a non-directory or symlink: ${current}`,
      );
    }
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

async function verifyDirectoryIdentities(
  identities: readonly DirectoryIdentity[],
): Promise<void> {
  for (const identity of identities) {
    const stat = await fs.lstat(identity.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    ) {
      throw new Error(
        `stability output directory identity changed: ${identity.path}`,
      );
    }
  }
}

async function authorityInitialStateHash(
  session: SyntheticControlSession,
): Promise<string> {
  const raw = await session.execute({ type: "snapshot" });
  assertScenarioStabilityBoundedJson(raw, "synthetic initial snapshot");
  const snapshot = structuredClone(raw) as unknown;
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const record = snapshot as Record<string, unknown>;
    // This top-level field is the fixture authority's documented control
    // envelope, not domain state. Preserve the field while normalizing its value.
    if (Object.hasOwn(record, "generation")) {
      if (record.generation !== session.generation) {
        throw new Error(
          "synthetic snapshot generation does not match the leased session",
        );
      }
      record.generation = "$synthetic-control-generation";
    }
  }
  return canonicalSha256(snapshot, "synthetic initial snapshot");
}

function canonicalSha256(value: unknown, source: string): string {
  assertScenarioStabilityBoundedJson(value, source);
  const canonical = canonicalJsonString(value, {
    maxDepth: 32,
    maxNodes: 100_000,
    maxOutputChars: SCENARIO_STABILITY_MAX_ATTEMPT_JSON_BYTES,
    sparseArrayHoles: "null",
    onUnbounded: () => {
      throw new Error(`${source} exceeds canonical JSON limits`);
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function isLoopbackUrl(raw: string): boolean {
  const url = new URL(raw);
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      url.hostname.startsWith("127.")) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

function validateEnvironment(
  values: Readonly<Record<string, string>>,
  source: string,
): void {
  for (const [name, value] of Object.entries(values)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error(`${source} contains invalid environment name '${name}'`);
    }
    if (typeof value !== "string" || Buffer.byteLength(value) > 64 * 1024) {
      throw new Error(`${source}.${name} must be a bounded string`);
    }
    if (CREDENTIAL_NAME.test(name) && !INTERNAL_CONTROL_ENV.has(name)) {
      throw new Error(
        `${source}.${name} is a real credential seam; only modelMode may supply a credential`,
      );
    }
    if (SERVICE_LOCATION_NAME.test(name)) {
      throw new Error(
        `${source}.${name} is a service location seam; declare it in mockServiceUrls`,
      );
    }
  }
}

function validateOptions(
  options: ScenarioStabilitySubprocessAdapterOptions,
): void {
  if (process.platform === "win32") {
    throw new Error(
      "strict stability subprocess isolation requires POSIX process groups",
    );
  }
  if (
    !path.isAbsolute(options.command) ||
    !path.isAbsolute(options.cwd) ||
    path.resolve(options.cwd) !== options.cwd
  ) {
    throw new Error("stability subprocess command and cwd must be absolute");
  }
  validateEnvironment(options.env ?? {}, "stability subprocess env");
  for (const [name, url] of Object.entries(options.mockServiceUrls ?? {})) {
    if (
      !ENVIRONMENT_NAME.test(name) ||
      CREDENTIAL_NAME.test(name) ||
      !isLoopbackUrl(url)
    ) {
      throw new Error(
        `mock service ${name} must be an explicit credential-free loopback HTTP URL`,
      );
    }
  }
  if (options.modelMode.kind === "real-llm") {
    if (
      !ENVIRONMENT_NAME.test(options.modelMode.credentialEnv) ||
      !CREDENTIAL_NAME.test(options.modelMode.credentialEnv) ||
      INTERNAL_CONTROL_ENV.has(options.modelMode.credentialEnv) ||
      options.modelMode.credentialValue.trim().length === 0 ||
      Buffer.byteLength(options.modelMode.credentialValue) > 64 * 1024
    ) {
      throw new Error(
        "real-llm mode requires one explicit bounded model credential",
      );
    }
  } else if (
    !/^[a-f0-9]{64}$/.test(options.modelMode.fixtureManifestFingerprint)
  ) {
    throw new Error(
      "deterministic-mock mode requires an exact fixture manifest fingerprint",
    );
  }
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maximumBytes: number,
  source: string,
): number {
  const total = currentBytes + chunk.byteLength;
  if (total > maximumBytes) {
    throw new Error(`${source} exceeds ${maximumBytes} bytes`);
  }
  chunks.push(chunk);
  return total;
}

function sanitizedStderr(
  options: ScenarioStabilitySubprocessAdapterOptions,
  chunks: readonly Buffer[],
): Buffer {
  let text = new TextDecoder().decode(Buffer.concat(chunks));
  const secrets = [
    options.syntheticControl.controlToken,
    ...(options.modelMode.kind === "real-llm"
      ? [options.modelMode.credentialValue]
      : []),
  ];
  for (const secret of secrets) {
    if (secret.length > 0) text = text.replaceAll(secret, "[REDACTED_SECRET]");
  }
  text = Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && character !== "\n" && character !== "\t") ||
      code === 127
      ? "?"
      : character;
  }).join("");
  return Buffer.from(text, "utf8");
}

async function persistStderrArtifact(
  outputDir: string,
  identities: readonly DirectoryIdentity[],
  bytes: Buffer,
): Promise<{ path: string; sha256: string; bytes: number }> {
  await verifyDirectoryIdentities(identities);
  const artifactPath = path.join(outputDir, "subprocess.stderr.log");
  const handle = await fs.open(
    artifactPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await verifyDirectoryIdentities(identities);
  return {
    path: artifactPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function signalProcessGroup(
  processGroupId: number | null,
  signal: NodeJS.Signals,
): void {
  if (processGroupId === null) return;
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    // error-policy:J6 ESRCH proves the isolated group has already terminated.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      logger.debug(
        `[scenario-stability] Process group ${processGroupId} was already absent during ${signal}`,
      );
      return;
    }
    throw error;
  }
}

function processGroupExists(processGroupId: number | null): boolean {
  if (processGroupId === null) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    // error-policy:J1 ESRCH is the process-boundary's explicit terminated state.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

function childEnvironment(
  options: ScenarioStabilitySubprocessAdapterOptions,
  input: Parameters<ScenarioStabilityExecutionAdapter["execute"]>[0],
  session: SyntheticControlSession,
  initialStateHash: string,
): NodeJS.ProcessEnv {
  const mode = options.modelMode;
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    TZ: process.env.TZ ?? "UTC",
    ...options.env,
    ...options.mockServiceUrls,
    ...(mode.kind === "real-llm"
      ? { [mode.credentialEnv]: mode.credentialValue }
      : {}),
    ELIZA_STABILITY_MODEL_MODE: mode.kind,
    ...(mode.kind === "deterministic-mock"
      ? {
          ELIZA_STRICT_FIXTURE_MANIFEST_FINGERPRINT:
            mode.fixtureManifestFingerprint,
        }
      : {}),
    SCENARIO_USE_DETERMINISTIC_MODEL:
      mode.kind === "deterministic-mock" ? "1" : "0",
    ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL:
      mode.kind === "deterministic-mock" ? "1" : "0",
    ELIZA_REQUIRE_MOCK_SERVICES: "1",
    ELIZA_SYNTHETIC_CONTROL_URL: options.syntheticControl.controlUrl,
    ELIZA_SYNTHETIC_CONTROL_TOKEN: options.syntheticControl.controlToken,
    ELIZA_SYNTHETIC_NAMESPACE: session.manifest.namespace,
    ELIZA_SYNTHETIC_MANIFEST_ID: session.manifest.manifestId,
    ELIZA_SYNTHETIC_GENERATION: String(session.generation),
    ELIZA_STABILITY_AUTHORITY_INITIAL_STATE_HASH: initialStateHash,
    ELIZA_STABILITY_ATTEMPT_ID: input.attemptId,
    ELIZA_STABILITY_OUTPUT_DIR: input.outputDir,
    ELIZA_STABILITY_SCENARIO_ID: input.target.scenarioId,
    ELIZA_STABILITY_PROVIDER: input.target.model.provider,
    ELIZA_STABILITY_MODEL: input.target.model.model,
  };
}

/** A production adapter that cannot execute an attempt in the controller process. */
export class ScenarioStabilitySubprocessAdapter
  implements ScenarioStabilityExecutionAdapter
{
  readonly #boundaries = new Map<string, AttemptBoundary>();
  readonly #openSession: typeof openScenarioSyntheticWorld;
  #quarantine: Error | null = null;

  constructor(readonly options: ScenarioStabilitySubprocessAdapterOptions) {
    validateOptions(options);
    this.#openSession = options.openSession ?? openScenarioSyntheticWorld;
  }

  async execute(
    input: Parameters<ScenarioStabilityExecutionAdapter["execute"]>[0],
  ): Promise<ScenarioStabilityAttemptExecution> {
    if (this.#quarantine) {
      throw new Error(
        "stability subprocess adapter is quarantined after an unproven teardown",
        { cause: this.#quarantine },
      );
    }
    if (input.signal.aborted) throw input.signal.reason;
    const outputIdentities = await ensureIsolatedDirectory(
      input.outputDir,
      this.options.cwd,
    );
    const session = await this.#openSession({
      controlUrl: this.options.syntheticControl.controlUrl,
      controlToken: this.options.syntheticControl.controlToken,
      manifest: this.options.syntheticControl.manifest,
      timeoutMs: this.options.syntheticControl.timeoutMs,
      owner: input.attemptId,
    });
    const boundary: AttemptBoundary = {
      session,
      child: null,
      processGroupId: null,
    };
    this.#boundaries.set(input.attemptId, boundary);
    const initialStateHash = await authorityInitialStateHash(session);
    const child = spawn(
      this.options.command,
      this.options.args({
        target: input.target,
        attemptId: input.attemptId,
        outputDir: input.outputDir,
      }),
      {
        cwd: this.options.cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnvironment(this.options, input, session, initialStateHash),
      },
    );
    boundary.child = child;
    boundary.processGroupId = child.pid ?? null;
    if (boundary.processGroupId === null) {
      throw new Error("stability subprocess did not expose a process group id");
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputFailure: Error | null = null;
    const stopForOutputFailure = (error: unknown): void => {
      outputFailure = error instanceof Error ? error : new Error(String(error));
      try {
        signalProcessGroup(boundary.processGroupId, "SIGKILL");
      } catch (signalError) {
        // error-policy:J6 The bounded-output failure remains authoritative; failed teardown is logged and retried by terminate().
        logger.warn(
          `[scenario-stability] Failed to stop oversized-output process group: ${signalError instanceof Error ? signalError.message : String(signalError)}`,
        );
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        stdoutBytes = appendBounded(
          stdout,
          chunk,
          stdoutBytes,
          SCENARIO_STABILITY_MAX_ATTEMPT_JSON_BYTES,
          "stability subprocess stdout",
        );
      } catch (error) {
        stopForOutputFailure(error);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      try {
        stderrBytes = appendBounded(
          stderr,
          chunk,
          stderrBytes,
          MAX_STDERR_BYTES,
          "stability subprocess stderr",
        );
      } catch (error) {
        stopForOutputFailure(error);
      }
    });
    const abort = (): void => {
      signalProcessGroup(boundary.processGroupId, "SIGTERM");
    };
    input.signal.addEventListener("abort", abort, { once: true });
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
    const stderrArtifact = await persistStderrArtifact(
      input.outputDir,
      outputIdentities,
      sanitizedStderr(this.options, stderr),
    );
    if (outputFailure) throw outputFailure;
    if (exitCode !== 0) {
      const excerpt = new TextDecoder()
        .decode(await fs.readFile(stderrArtifact.path))
        .trim()
        .slice(0, 4_000);
      throw new Error(
        `stability subprocess exited unsuccessfully${excerpt ? `: ${excerpt}` : ""}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)),
      ) as unknown;
    } catch (cause) {
      // error-policy:J2 Subprocess output is untrusted and becomes a stable harness failure with its cause retained privately.
      throw new Error("stability subprocess returned invalid JSON", { cause });
    }
    const execution = parseScenarioStabilityAttemptExecution(parsed);
    if (execution.initialStateHash !== initialStateHash) {
      throw new Error(
        "subprocess initial state hash does not match synthetic authority snapshot",
      );
    }
    if (this.options.modelMode.kind === "deterministic-mock") {
      const expected = this.options.modelMode.fixtureManifestFingerprint;
      const authoritative = execution.evidence.providerReceipts.filter(
        (value) =>
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as Record<string, unknown>).fixtureMode === "strict-fixtures",
      );
      const record = authoritative[0] as Record<string, unknown> | undefined;
      if (
        authoritative.length !== 1 ||
        !record ||
        record.fixtureManifestFingerprint !== expected ||
        record.unmatchedCalls !== 0 ||
        record.ambiguousCalls !== 0 ||
        record.unusedRequiredFixtures !== 0 ||
        record.overconsumedFixtures !== 0
      ) {
        throw new Error(
          "deterministic subprocess must provide exactly one exact zero-diagnostic fixture receipt",
        );
      }
    } else {
      const receipts = execution.evidence.providerReceipts.filter((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return false;
        return (
          (value as Record<string, unknown>).receiptType ===
          "eliza.stability.real-llm.v1"
        );
      });
      const receipt = receipts[0] as Record<string, unknown> | undefined;
      if (
        receipts.length !== 1 ||
        !receipt ||
        receipt.provider !== input.target.model.provider ||
        receipt.model !== input.target.model.model ||
        receipt.liveModelInvoked !== true ||
        receipt.namespace !== session.manifest.namespace ||
        receipt.manifestId !== session.manifest.manifestId ||
        receipt.generation !== session.generation ||
        receipt.unexpectedRealServiceCalls !== 0 ||
        receipt.unexpectedNetworkCalls !== 0
      ) {
        throw new Error(
          "real-LLM subprocess did not provide one exact mock-world invocation receipt",
        );
      }
    }
    const receipt = {
      isolation: "subprocess-process-group",
      processGroupId: boundary.processGroupId,
      namespace: session.manifest.namespace,
      manifestId: session.manifest.manifestId,
      generation: session.generation,
      manifestFingerprint: canonicalSha256(
        session.manifest,
        "synthetic manifest",
      ),
      modelMode: this.options.modelMode.kind,
      mockServicesRequired: true,
      authorityInitialStateHash: initialStateHash,
      stderrArtifact: stderrArtifact.path,
      stderrSha256: stderrArtifact.sha256,
      stderrBytes: stderrArtifact.bytes,
    };
    return parseScenarioStabilityAttemptExecution({
      ...execution,
      evidence: {
        ...execution.evidence,
        providerReceipts: [...execution.evidence.providerReceipts, receipt],
      },
    });
  }

  async terminate(
    input: Parameters<ScenarioStabilityExecutionAdapter["terminate"]>[0],
  ): Promise<void> {
    const boundary = this.#boundaries.get(input.attemptId);
    if (!boundary) return;
    try {
      signalProcessGroup(boundary.processGroupId, "SIGTERM");
      signalProcessGroup(boundary.processGroupId, "SIGKILL");
      const deadline = Date.now() + 2_000;
      while (
        processGroupExists(boundary.processGroupId) &&
        Date.now() < deadline
      ) {
        if (input.signal.aborted) {
          throw new Error(
            "stability teardown was cancelled before process-group absence was proven",
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (processGroupExists(boundary.processGroupId)) {
        throw new Error(
          "stability subprocess group remained alive after SIGKILL",
        );
      }
      if (input.signal.aborted) {
        throw new Error(
          "stability teardown was cancelled before synthetic reset completed",
        );
      }
      await boundary.session.close();
      this.#boundaries.delete(input.attemptId);
    } catch (error) {
      // error-policy:J2 A failed process/session teardown quarantines this adapter so no later attempt can claim a clean namespace.
      this.#quarantine =
        error instanceof Error ? error : new Error("stability teardown failed");
      throw this.#quarantine;
    }
  }
}
