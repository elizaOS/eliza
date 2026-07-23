#!/usr/bin/env bun
/**
 * Long-lived operator process for one benchmark cohort. It opens crash-safe
 * audit/replay journals before publishing private connection material.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DurableAuditStore } from "./audit.js";
import {
  assertNoApiBillingEnvironment,
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeSdkCompletionRunner,
} from "./claude-completion.js";
import { parseGatewayContentContract } from "./content-attestation.js";
import {
  type CredentialLeaseBroker,
  RotatingCredentialCompletionRunner,
} from "./credential-rotation.js";
import { ReplayJournal } from "./replay-journal.js";
import {
  type ClaudeSubscriptionGatewayHandle,
  GatewayStorageError,
  type GatewayStorageGuard,
  startClaudeSubscriptionGateway,
} from "./server.js";
import type { GatewayAuditRecord } from "./types.js";

const PRIVATE_FILE_MODE = 0o600;

export interface GatewayCliArguments {
  readyFile: string;
  auditFile: string;
  contentContractFile: string | null;
  replayFile: string;
  hmacKeyFile: string;
  benchmarkNamespace: string;
  storageRoot: string;
  minimumFreeBytes: number;
}

export interface GatewayReadinessDocument {
  schema_version: 1;
  status: "ready";
  pid: number;
  origin: string;
  base_url: string;
  health_url: string;
  transport: {
    provider: "claude-agent-sdk";
    sdk_version: "0.3.200";
    credential_policy: "claude-code-oauth-only";
    fresh_session_per_request: true;
    tool_execution: "capture-only";
    response_modes: ["json", "sse"];
  };
  harness_tokens: Readonly<Record<string, string>>;
  credential_readiness: {
    linked_pool_configured: boolean;
    linked_pool_selectable: boolean;
    ambient_keychain_required: boolean;
  };
}

export interface GatewayCliDependencies {
  environment?: Readonly<NodeJS.ProcessEnv>;
  pid?: number;
  startGateway?: typeof startClaudeSubscriptionGateway;
}

export class GatewayCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayCliError";
    this.code = code;
  }
}

export async function runGatewayCli(
  argv: readonly string[],
  dependencies: GatewayCliDependencies = {},
): Promise<void> {
  const arguments_ = parseGatewayCliArguments(argv);
  const environment = dependencies.environment ?? process.env;
  assertNoApiBillingEnvironment(environment);
  const contentContract =
    arguments_.contentContractFile === null
      ? undefined
      : await loadContentContract(arguments_.contentContractFile);
  const auditStore = await DurableAuditStore.open(arguments_.auditFile);
  let replayJournal: ReplayJournal | null = null;
  let gateway: ClaudeSubscriptionGatewayHandle;
  let brokerReadiness: BrokerReadiness;
  try {
    replayJournal = await ReplayJournal.open(arguments_.replayFile);
    const hmacKey = await loadOrCreateHmacKey(arguments_.hmacKeyFile);
    const broker = await loadCanonicalAccountPoolBroker();
    brokerReadiness = await inspectBrokerReadiness(broker);
    const credentialParity = replayJournal.credentialParity();
    const completionRunner = new RotatingCredentialCompletionRunner({
      completionRunner: new ClaudeSdkCompletionRunner({ environment }),
      broker,
      hmacKey,
      expectedTierHmacSha256: credentialParity.tierHmacSha256,
      expectedCapabilityHmacSha256: credentialParity.capabilityHmacSha256,
      ambientFallbackAllowed: !brokerReadiness.linkedPoolConfigured,
    });
    const startGateway =
      dependencies.startGateway ?? startClaudeSubscriptionGateway;
    gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      auditSink: auditStore,
      replayJournal,
      benchmarkNamespace: arguments_.benchmarkNamespace,
      storageGuard: new MinimumFreeSpaceGuard(
        arguments_.storageRoot,
        arguments_.minimumFreeBytes,
      ),
      completionRunner,
      contentContract,
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      auditStore.close(),
      ...(replayJournal === null ? [] : [replayJournal.close()]),
    ]);
    throw error;
  }
  const readiness = makeReadinessDocument(
    gateway,
    dependencies.pid ?? process.pid,
    brokerReadiness,
  );
  try {
    await writeReadinessFile(arguments_.readyFile, readiness);
  } catch (error: unknown) {
    // error-policy:J1 readiness publication is the CLI startup boundary; a
    // process that cannot publish private connection material must not remain up.
    await gateway.close();
    await Promise.allSettled([auditStore.close(), replayJournal.close()]);
    throw new GatewayCliError(
      "readiness_publication_failed",
      "The gateway could not publish its private readiness artifact.",
      { cause: error },
    );
  }

  await waitForShutdownSignal();
  let shutdownFailure: unknown = null;
  try {
    await gateway.close();
  } catch (error: unknown) {
    // error-policy:J6 audit and secret cleanup must still run when server
    // teardown fails; the controlled failure is raised after both complete.
    shutdownFailure = error;
  }
  try {
    await replayJournal.close();
    await auditStore.close();
  } catch (error: unknown) {
    // error-policy:J1 durable logs are process-boundary artifacts; failure to
    // flush or close them makes graceful shutdown observably fail.
    shutdownFailure = shutdownFailure
      ? new AggregateError([shutdownFailure, error])
      : error;
  } finally {
    // error-policy:J6 the orchestrator normally removes readiness immediately
    // after parsing it, so force-removal deliberately tolerates ENOENT.
    await rm(arguments_.readyFile, { force: true });
  }
  if (shutdownFailure) {
    throw new GatewayCliError(
      "graceful_shutdown_failed",
      "The gateway could not complete graceful cohort shutdown.",
      { cause: shutdownFailure },
    );
  }
}

export function parseGatewayCliArguments(
  argv: readonly string[],
): GatewayCliArguments {
  const normalized = argv.filter((argument) => argument !== "--");
  let readyFile: string | null = null;
  let auditFile: string | null = null;
  let contentContractFile: string | null = null;
  let replayFile: string | null = null;
  let hmacKeyFile: string | null = null;
  let benchmarkNamespace = "default";
  let storageRoot: string | null = null;
  let minimumFreeBytes = 0;
  for (let index = 0; index < normalized.length; index += 2) {
    const flag = normalized[index];
    const value = normalized[index + 1];
    if (!value) {
      throw new GatewayCliError(
        "invalid_arguments",
        "Gateway file flags require absolute paths.",
      );
    }
    if (flag === "--ready-file") readyFile = privateTarget(value, flag);
    else if (flag === "--audit-file") auditFile = privateTarget(value, flag);
    else if (flag === "--content-contract-file") {
      contentContractFile = privateTarget(value, flag);
    } else if (flag === "--replay-file") {
      replayFile = privateTarget(value, flag);
    } else if (flag === "--hmac-key-file") {
      hmacKeyFile = privateTarget(value, flag);
    } else if (flag === "--benchmark-namespace") {
      benchmarkNamespace = value;
    } else if (flag === "--storage-root") {
      storageRoot = privateTarget(value, flag);
    } else if (flag === "--minimum-free-bytes") {
      minimumFreeBytes = nonNegativeInteger(value, flag);
    } else {
      throw new GatewayCliError(
        "invalid_arguments",
        "An unsupported gateway lifecycle flag was supplied.",
      );
    }
  }
  if (!readyFile || !auditFile || readyFile === auditFile) {
    throw new GatewayCliError(
      "invalid_arguments",
      "Distinct absolute --ready-file and --audit-file paths are required.",
    );
  }
  replayFile ??= `${auditFile}.responses.jsonl`;
  hmacKeyFile ??= `${replayFile}.hmac-key`;
  storageRoot ??= dirname(auditFile);
  if (new Set([readyFile, auditFile, replayFile, hmacKeyFile]).size !== 4) {
    throw new GatewayCliError(
      "invalid_arguments",
      "Gateway readiness, audit, replay, and HMAC-key paths must be distinct.",
    );
  }
  if (
    contentContractFile !== null &&
    [readyFile, auditFile, replayFile, hmacKeyFile].includes(
      contentContractFile,
    )
  ) {
    throw new GatewayCliError(
      "invalid_arguments",
      "The content contract path must be distinct from gateway artifacts.",
    );
  }
  return {
    readyFile,
    auditFile,
    contentContractFile,
    replayFile,
    hmacKeyFile,
    benchmarkNamespace,
    storageRoot,
    minimumFreeBytes,
  };
}

export async function writeReadinessFile(
  target: string,
  readiness: GatewayReadinessDocument,
): Promise<void> {
  await writePrivateFile(target, `${JSON.stringify(readiness)}\n`);
}

export async function writeAuditJsonl(
  target: string,
  records: readonly GatewayAuditRecord[],
): Promise<void> {
  const store = await DurableAuditStore.open(target);
  try {
    for (const record of records) await store.append(record);
  } finally {
    await store.close();
  }
}

function makeReadinessDocument(
  gateway: ClaudeSubscriptionGatewayHandle,
  pid: number,
  brokerReadiness: BrokerReadiness,
): GatewayReadinessDocument {
  return {
    schema_version: 1,
    status: "ready",
    pid,
    origin: gateway.origin,
    base_url: gateway.baseUrl,
    health_url: gateway.healthUrl,
    transport: {
      provider: "claude-agent-sdk",
      sdk_version: CLAUDE_AGENT_SDK_VERSION,
      credential_policy: "claude-code-oauth-only",
      fresh_session_per_request: true,
      tool_execution: "capture-only",
      response_modes: ["json", "sse"],
    },
    harness_tokens: gateway.harnessTokens,
    credential_readiness: {
      linked_pool_configured: brokerReadiness.linkedPoolConfigured,
      linked_pool_selectable: brokerReadiness.linkedPoolSelectable,
      ambient_keychain_required: !brokerReadiness.linkedPoolConfigured,
    },
  };
}

async function loadContentContract(target: string) {
  try {
    const fileStat = await stat(target);
    if (
      !fileStat.isFile() ||
      (Number(fileStat.mode) & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new TypeError("content contract must be a private regular file");
    }
    const raw = await readFile(target, "utf8");
    return parseGatewayContentContract(JSON.parse(raw));
  } catch (error: unknown) {
    // error-policy:J2 startup must bind every later audit record to one
    // validated contract; keep file contents and paths out of the error.
    throw new GatewayCliError(
      "invalid_content_contract",
      "The gateway content-attestation contract is invalid.",
      { cause: error },
    );
  }
}

async function writePrivateFile(
  target: string,
  content: string,
): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temporary, PRIVATE_FILE_MODE);
    await rename(temporary, target);
    await chmod(target, PRIVATE_FILE_MODE);
  } catch (error: unknown) {
    // error-policy:J2 private artifacts use atomic same-directory publication;
    // add controlled context after removing any unpublished temporary file.
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError: unknown) {
      // error-policy:J2 a failed private-temp cleanup is retained as a cause so
      // the process boundary can fail without printing either file's content.
      throw new GatewayCliError(
        "private_artifact_cleanup_failed",
        "A private gateway artifact and its temporary file could not be persisted safely.",
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw new GatewayCliError(
      "private_artifact_write_failed",
      "A private gateway artifact could not be persisted safely.",
      { cause: error },
    );
  }
}

export class MinimumFreeSpaceGuard implements GatewayStorageGuard {
  constructor(
    private readonly root: string,
    private readonly minimumFreeBytes: number,
  ) {}

  async assertReady(): Promise<void> {
    if (this.minimumFreeBytes === 0) return;
    const fileSystem = await statfs(this.root);
    const availableBytes = BigInt(fileSystem.bavail) * BigInt(fileSystem.bsize);
    if (availableBytes < BigInt(this.minimumFreeBytes)) {
      throw new GatewayStorageError();
    }
  }
}

async function loadOrCreateHmacKey(target: string): Promise<Buffer> {
  try {
    return await loadHmacKey(target);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const key = randomBytes(32);
  let file: FileHandle;
  try {
    file = await open(target, "wx", PRIVATE_FILE_MODE);
  } catch (error: unknown) {
    if (hasErrorCode(error, "EEXIST")) return loadHmacKey(target);
    throw error;
  }
  try {
    await file.writeFile(`${key.toString("base64url")}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return key;
}

async function loadHmacKey(target: string): Promise<Buffer> {
  const fileStat = await stat(target);
  if (
    !fileStat.isFile() ||
    (Number(fileStat.mode) & 0o777) !== PRIVATE_FILE_MODE
  ) {
    throw new GatewayCliError(
      "invalid_hmac_key_file",
      "The gateway HMAC key file must be a private regular file.",
    );
  }
  const encoded = (await readFile(target, "utf8")).trim();
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    throw new GatewayCliError(
      "invalid_hmac_key_file",
      "The gateway HMAC key file is invalid.",
    );
  }
  return key;
}

async function loadCanonicalAccountPoolBroker(): Promise<CredentialLeaseBroker> {
  const moduleUrl = new URL(
    "../../../app-core/src/services/account-pool-broker.ts",
    import.meta.url,
  ).href;
  const loaded: unknown = await import(moduleUrl);
  const brokerConstructor =
    typeof loaded === "object" && loaded !== null
      ? Reflect.get(loaded, "AccountPoolBroker")
      : null;
  if (typeof brokerConstructor !== "function") {
    throw new GatewayCliError(
      "account_pool_unavailable",
      "The canonical account-pool broker is unavailable.",
    );
  }
  const broker: unknown = Reflect.construct(brokerConstructor, []);
  if (
    typeof broker !== "object" ||
    broker === null ||
    typeof Reflect.get(broker, "lease") !== "function" ||
    typeof Reflect.get(broker, "report") !== "function" ||
    typeof Reflect.get(broker, "release") !== "function" ||
    typeof Reflect.get(broker, "health") !== "function"
  ) {
    throw new GatewayCliError(
      "account_pool_unavailable",
      "The canonical account-pool broker has an invalid contract.",
    );
  }
  return broker as CredentialLeaseBroker;
}

export interface BrokerReadiness {
  linkedPoolConfigured: boolean;
  linkedPoolSelectable: boolean;
}

export async function inspectBrokerReadiness(
  broker: CredentialLeaseBroker,
): Promise<BrokerReadiness> {
  if (!broker.health) {
    throw new GatewayCliError(
      "account_pool_unavailable",
      "The canonical account-pool broker has an invalid health contract.",
    );
  }
  const providers = broker.health().providers;
  const matches = providers.filter(
    (candidate) => candidate.providerId === "anthropic-subscription",
  );
  if (matches.length > 1) {
    throw new GatewayCliError(
      "account_pool_unavailable",
      "The canonical account-pool broker returned duplicate provider health.",
    );
  }
  const provider = matches[0];
  const total = provider ? provider.total : 0;
  const selectable = provider ? provider.selectable : 0;
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(selectable) ||
    selectable < 0 ||
    selectable > total
  ) {
    throw new GatewayCliError(
      "account_pool_unavailable",
      "The canonical account-pool broker returned invalid provider health.",
    );
  }
  if (total > 0 && selectable === 0) {
    return { linkedPoolConfigured: true, linkedPoolSelectable: false };
  }
  if (total === 0) {
    return { linkedPoolConfigured: false, linkedPoolSelectable: false };
  }
  const lease = await broker.lease({
    providerId: "anthropic-subscription",
    sessionKey: "claude-benchmark:startup-preflight",
    strategy: "quota-aware",
  });
  if (lease === null) {
    return { linkedPoolConfigured: true, linkedPoolSelectable: false };
  }
  try {
    if (lease.providerId !== "anthropic-subscription") {
      throw new GatewayCliError(
        "account_pool_provider_mismatch",
        "The account pool selected a non-Claude provider.",
      );
    }
    return { linkedPoolConfigured: true, linkedPoolSelectable: true };
  } finally {
    broker.release({ leaseId: lease.leaseId });
  }
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new GatewayCliError(
      "invalid_arguments",
      `${flag} must be a non-negative safe integer.`,
    );
  }
  return parsed;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === code
  );
}

function privateTarget(value: string, flag: string): string {
  if (!isAbsolute(value)) {
    throw new GatewayCliError(
      "invalid_arguments",
      `${flag} must be an absolute path.`,
    );
  }
  return resolve(value);
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const onSignal = () => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      resolveSignal();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href,
  );
}

if (isMainModule()) {
  void runGatewayCli(process.argv.slice(2)).catch((_error: unknown) => {
    // error-policy:J1 stderr is the CLI process boundary; emit a fixed message
    // that cannot contain credentials, paths, prompts, or upstream errors.
    process.stderr.write(
      "[ClaudeSubscriptionGatewayCli] lifecycle failed; no secret values were printed.\n",
    );
    process.exitCode = 1;
  });
}
