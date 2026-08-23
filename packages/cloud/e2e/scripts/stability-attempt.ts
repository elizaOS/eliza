/**
 * Runs one Cloud stability attempt in its dedicated process group. It boots the
 * canonical mock Cloud stack, executes the production scenario runner against
 * a real AgentRuntime, and emits retained runtime/action/durable evidence.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import cloudStabilityScenario from "../scenarios/cloud-stability-agent.scenario.ts";
import { startCloudStack } from "../src/fixtures/stack.ts";
import { canonicalCloudStabilitySha256 } from "../src/stability/cloud-stability-runner.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Cloud stability attempt requires ${name}`);
  return value;
};
const outputDir = required("ELIZA_STABILITY_OUTPUT_DIR");
const mode = required("ELIZA_STABILITY_MODEL_MODE");
const provider = required("ELIZA_STABILITY_PROVIDER");
const model = required("ELIZA_STABILITY_MODEL");
const initialStateHash = required(
  "ELIZA_STABILITY_AUTHORITY_INITIAL_STATE_HASH",
);
const namespace = required("ELIZA_SYNTHETIC_NAMESPACE");
const manifestId = required("ELIZA_SYNTHETIC_MANIFEST_ID");
const generation = Number(required("ELIZA_SYNTHETIC_GENERATION"));
if (!Number.isSafeInteger(generation)) throw new Error("invalid generation");
const fixtureFingerprint = canonicalCloudStabilitySha256(
  cloudStabilityScenario.modelFixtures,
);
const scenarioFingerprint = canonicalCloudStabilitySha256(
  cloudStabilityScenario.contract,
);
const runtimePolicy = cloudStabilityScenario.contract.syntheticRuntimePolicy;
const selectedModelPluginName =
  mode === "deterministic-mock"
    ? runtimePolicy.modelPluginNames.deterministic
    : runtimePolicy.modelPluginNames[
        provider as keyof typeof runtimePolicy.modelPluginNames
      ];
if (!selectedModelPluginName) {
  throw new Error(
    `synthetic runtime policy has no model plugin for ${provider}`,
  );
}
const serializedRuntimePolicy = JSON.stringify({
  allowedPluginNames: [
    ...runtimePolicy.basePluginNames,
    selectedModelPluginName,
  ],
  allowedServiceTypes: runtimePolicy.allowedServiceTypes,
});
if (scenarioFingerprint !== required("ELIZA_STABILITY_SCENARIO_FINGERPRINT")) {
  throw new Error(
    "scenario fingerprint does not bind the canonical scenario contract",
  );
}
const worldFingerprint = required("ELIZA_STABILITY_WORLD_FINGERPRINT");
if (!/^[a-f0-9]{64}$/.test(worldFingerprint)) {
  throw new Error("synthetic world fingerprint is not canonical SHA-256");
}
if (
  mode === "deterministic-mock" &&
  fixtureFingerprint !== required("ELIZA_STRICT_FIXTURE_MANIFEST_FINGERPRINT")
) {
  throw new Error(
    "fixture fingerprint does not bind the canonical scenario manifest",
  );
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const scenarioPath = path.join(
  repoRoot,
  "packages/cloud/e2e/scenarios/cloud-stability-agent.scenario.ts",
);
const scenarioReportPath = path.join(outputDir, "scenario-report.json");
const nativePath = path.join(outputDir, "trajectory.native.jsonl");
const networkLedger: Array<{
  origin: string;
  method: string;
  allowed: boolean;
}> = [];

const nativeFetch = globalThis.fetch;
const providerRoutes: Record<
  string,
  {
    origin: string;
    baseUrlEnvironment: "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL";
  }
> = {
  openai: {
    origin: "https://api.openai.com",
    baseUrlEnvironment: "OPENAI_BASE_URL",
  },
  anthropic: {
    origin: "https://api.anthropic.com",
    baseUrlEnvironment: "ANTHROPIC_BASE_URL",
  },
};
const guardedFetch: typeof globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof nativeFetch>[0],
    init?: Parameters<typeof nativeFetch>[1],
  ) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      url.hostname.startsWith("127.");
    const allowed =
      loopback ||
      (mode === "real-llm" && providerRoutes[provider]?.origin === url.origin);
    networkLedger.push({
      origin: url.origin,
      method: init?.method ?? "GET",
      allowed,
    });
    if (!allowed) throw new Error(`unexpected egress blocked: ${url.origin}`);
    return nativeFetch(input, init);
  },
  { preconnect: nativeFetch.preconnect },
);
globalThis.fetch = guardedFetch;

async function startModelEgressProxy(): Promise<{
  url: string;
  requestCount: () => number;
  stop: () => Promise<void>;
}> {
  const route = providerRoutes[provider];
  if (!route) throw new Error(`unsupported real-model provider ${provider}`);
  let requests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let requestBytes = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        requestBytes += bytes.byteLength;
        if (requestBytes > 8 * 1024 * 1024) {
          throw new Error("provider proxy request exceeded 8 MiB");
        }
        chunks.push(bytes);
      }
      requests += 1;
      const upstream = await nativeFetch(
        `${route.origin}${request.url ?? "/"}`,
        {
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers).flatMap(([key, value]) =>
              value === undefined
                ? []
                : [[key, Array.isArray(value) ? value.join(",") : value]],
            ),
          ),
          body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          signal: AbortSignal.timeout(120_000),
        },
      );
      networkLedger.push({
        origin: route.origin,
        method: request.method ?? "GET",
        allowed: true,
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      if (responseBytes.byteLength > 16 * 1024 * 1024) {
        throw new Error("provider proxy response exceeded 16 MiB");
      }
      const headers = Object.fromEntries(upstream.headers);
      delete headers["content-encoding"];
      delete headers["content-length"];
      delete headers.connection;
      delete headers["transfer-encoding"];
      response.writeHead(upstream.status, headers);
      response.end(responseBytes);
    })().catch((error: unknown) => {
      // error-policy:J1 The loopback proxy translates selected-provider failures to the scenario client.
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message:
              error instanceof Error ? error.message : "provider proxy failure",
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requestCount: () => requests,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

type MockOperation = {
  service: "cloud-api" | "hetzner";
  method: string;
  path: string;
  status: number;
};

async function startMockAuditProxy(
  service: MockOperation["service"],
  upstreamBase: string,
  operations: MockOperation[],
): Promise<{ url: string; stop: () => Promise<void> }> {
  const upstream = new URL(upstreamBase);
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > 8 * 1024 * 1024)
          throw new Error("mock request exceeded 8 MiB");
        chunks.push(bytes);
      }
      const incomingPath = request.url ?? "/";
      const basePath = upstream.pathname.endsWith("/")
        ? upstream.pathname.slice(0, -1)
        : upstream.pathname;
      const target = new URL(`${basePath}${incomingPath}`, upstream.origin);
      const result = await nativeFetch(target, {
        method: request.method,
        headers: Object.fromEntries(
          Object.entries(request.headers).flatMap(([key, value]) =>
            value === undefined
              ? []
              : [[key, Array.isArray(value) ? value.join(",") : value]],
          ),
        ),
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const responseBytes = Buffer.from(await result.arrayBuffer());
      if (responseBytes.byteLength > 16 * 1024 * 1024) {
        throw new Error("mock response exceeded 16 MiB");
      }
      operations.push({
        service,
        method: request.method ?? "GET",
        path: incomingPath,
        status: result.status,
      });
      const headers = Object.fromEntries(result.headers);
      delete headers["content-encoding"];
      delete headers["content-length"];
      delete headers.connection;
      delete headers["transfer-encoding"];
      response.writeHead(result.status, headers);
      response.end(responseBytes);
    })().catch((error: unknown) => {
      // error-policy:J1 The local audit proxy translates mock transport failures.
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "mock proxy failure",
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // error-policy:J1 ESRCH is the explicit absent process-group state.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // error-policy:J6 ESRCH proves teardown is already complete.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return;
    throw error;
  }
}

async function terminateGroup(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processGroupExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processGroupExists(pid)) signalGroup(pid, "SIGKILL");
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline && processGroupExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processGroupExists(pid))
    throw new Error("scenario CLI process group survived SIGKILL");
}

const stack = await startCloudStack({
  frontend: false,
  mockLlm: false,
  logDir: path.join(outputDir, "cloud-stack-logs"),
});
const mockOperations: MockOperation[] = [];
const cloudApiProxy = await startMockAuditProxy(
  "cloud-api",
  stack.urls.api,
  mockOperations,
);
const hetznerProxy = await startMockAuditProxy(
  "hetzner",
  stack.urls.hetzner,
  mockOperations,
);
const modelProxy =
  mode === "real-llm" ? await startModelEgressProxy() : undefined;
const childNetworkLedgerPath = path.join(
  outputDir,
  "child-network-ledger.jsonl",
);
const childRuntimeLedgerPath = path.join(
  outputDir,
  "child-runtime-ledger.json",
);
const childQuiescenceLedgerPath = path.join(
  outputDir,
  "child-quiescence-ledger.json",
);
let cliStdout = "";
let cliStderr = "";
let cliCode: number | null = null;
let cliClosedAt = 0;
try {
  const args = [
    "--conditions=eliza-source",
    "--preload",
    path.join(
      repoRoot,
      "packages/cloud/e2e/scripts/stability-network-guard.mjs",
    ),
    "packages/cloud/e2e/scripts/stability-scenario-child.ts",
    "run",
    scenarioPath,
    "--scenario",
    "cloud-stability-agent",
    "--report",
    scenarioReportPath,
    "--run-dir",
    outputDir,
    "--export-native",
    nativePath,
    "--runId",
    required("ELIZA_STABILITY_ATTEMPT_ID"),
    ...(mode === "real-llm" ? ["--provider", provider] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CLOUD_E2E_API_URL: cloudApiProxy.url,
      CLOUD_E2E_CONTROL_PLANE_URL: stack.urls.controlPlane,
      CLOUD_E2E_HETZNER_URL: hetznerProxy.url,
      ELIZA_SCENARIO_MODEL: model,
      ...(modelProxy
        ? { [providerRoutes[provider].baseUrlEnvironment]: modelProxy.url }
        : {}),
      ELIZA_STABILITY_CHILD_NETWORK_LEDGER: childNetworkLedgerPath,
      ELIZA_STABILITY_CHILD_QUIESCENCE_LEDGER: childQuiescenceLedgerPath,
      ELIZA_SYNTHETIC_RUNTIME_LEDGER: childRuntimeLedgerPath,
      ELIZA_SYNTHETIC_RUNTIME_POLICY: serializedRuntimePolicy,
      ELIZA_SYNTHETIC_DISABLE_CONNECTOR_GRANTS: "1",
      SCENARIO_USE_DETERMINISTIC_MODEL:
        mode === "deterministic-mock" ? "1" : "0",
      ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL:
        mode === "deterministic-mock" ? "1" : "0",
    },
  });
  if (!child.pid) throw new Error("scenario CLI omitted its process-group id");
  const childProcessGroupId = child.pid;
  child.stdout?.on("data", (chunk: Buffer) => {
    cliStdout += chunk.toString("utf8");
    if (Buffer.byteLength(cliStdout) > 8 * 1024 * 1024) {
      signalGroup(childProcessGroupId, "SIGKILL");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    cliStderr += chunk.toString("utf8");
    if (Buffer.byteLength(cliStderr) > 2 * 1024 * 1024) {
      signalGroup(childProcessGroupId, "SIGKILL");
    }
  });
  let escalation: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    signalGroup(childProcessGroupId, "SIGTERM");
    escalation = setTimeout(
      () => signalGroup(childProcessGroupId, "SIGKILL"),
      5_000,
    );
    escalation.unref();
  }, 180_000);
  timeout.unref();
  cliCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  cliClosedAt = Date.now();
  clearTimeout(timeout);
  if (escalation) clearTimeout(escalation);
  await terminateGroup(childProcessGroupId);
} finally {
  if (modelProxy) await modelProxy.stop();
  await cloudApiProxy.stop();
  await hetznerProxy.stop();
  await stack.stop();
}

const explicitSecrets = [
  process.env.OPENAI_API_KEY,
  process.env.ANTHROPIC_API_KEY,
  process.env.ELIZA_SYNTHETIC_CONTROL_TOKEN,
].filter(
  (value): value is string => typeof value === "string" && value.length > 0,
);
const ambientServiceLogEvidence = [cliStdout, cliStderr].filter((value) =>
  /(?:Initializing iMessage plugin|chat\.db opened|Library\/Messages\/chat\.db|\bROWID\s+\d+)/u.test(
    value,
  ),
).length;
const redact = (value: string): string =>
  explicitSecrets
    .reduce(
      (result, secret) => result.split(secret).join("[REDACTED]"),
      value,
    )
    .replace(
      /(?:\/Users\/[^/\s]+)?\/Library\/Messages\/chat\.db/gu,
      "[REDACTED_HOST_MESSAGES_DB]",
    )
    .replace(/\bROWID\s+\d+/gu, "ROWID [REDACTED]");
cliStdout = redact(cliStdout);
cliStderr = redact(cliStderr);
await writeFile(path.join(outputDir, "scenario.stdout.log"), cliStdout, {
  encoding: "utf8",
  mode: 0o600,
});
await writeFile(path.join(outputDir, "scenario.stderr.log"), cliStderr, {
  encoding: "utf8",
  mode: 0o600,
});
const scenarioReport = JSON.parse(
  await readFile(scenarioReportPath, "utf8"),
) as {
  scenarios?: Array<{
    status?: string;
    turns?: Array<{
      responseText?: string;
      actionsCalled?: unknown[];
      stateTransitions?: unknown[];
    }>;
    actionsCalled?: unknown[];
    modelFixtureMode?: string;
    modelFixtureDiagnostics?: {
      unexpectedCalls?: unknown[];
      fixtures?: Array<{
        consumed: number;
        min: number;
        max: number | "unbounded";
        required: boolean;
      }>;
    };
  }>;
};
const scenarioResult = scenarioReport.scenarios?.[0];
if (!scenarioResult) throw new Error("scenario report omitted its result");
const turns = scenarioResult.turns ?? [];
const actions =
  scenarioResult.actionsCalled ??
  turns.flatMap((turn) => turn.actionsCalled ?? []);
const transitions = turns.flatMap((turn) => turn.stateTransitions ?? []);
const childNetworkLedger = await readFile(childNetworkLedgerPath, "utf8")
  .then((bytes) =>
    bytes
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            origin: string;
            method: string;
            allowed: boolean;
          },
      ),
  )
  .catch((error: unknown) => {
    // error-policy:J3 A missing/malformed mandatory ledger makes the attempt invalid.
    throw new Error("scenario child network ledger is unreadable", {
      cause: error,
    });
  });
const childRuntimeLedger = JSON.parse(
  await readFile(childRuntimeLedgerPath, "utf8"),
) as {
  events?: Array<{
    phase?: string;
    resourceKind?: string;
    resourceName?: string;
    outcome?: string;
    services?: Array<{
      serviceType?: string;
      constructorName?: string;
      hasStop?: boolean;
    }>;
  }>;
  reportedErrors?: unknown[];
};
const childQuiescenceLedger = JSON.parse(
  await readFile(childQuiescenceLedgerPath, "utf8"),
) as {
  recordedAt?: string;
  handles?: Array<{ constructorName?: string; fd?: number }>;
  requests?: unknown[];
};
const quiescenceRecordedAt = Date.parse(childQuiescenceLedger.recordedAt ?? "");
const naturalExitLatencyMs = cliClosedAt - quiescenceRecordedAt;
const unexpectedActiveHandles = (childQuiescenceLedger.handles ?? []).filter(
  (handle) =>
    handle.constructorName !== "Socket" ||
    (handle.fd !== undefined && handle.fd !== 1 && handle.fd !== 2),
);
const activeRequests = childQuiescenceLedger.requests ?? [];
const deniedRuntimeAdmissions = (childRuntimeLedger.events ?? []).filter(
  (entry) => entry.outcome === "denied-undeclared-registration",
);
const ambientRealServices = (childRuntimeLedger.events ?? [])
  .flatMap((entry) => entry.services ?? [])
  .filter((service) => service.serviceType === "imessage");
const runtimeErrors = childRuntimeLedger.reportedErrors ?? [];
const unexpectedEgress = [...networkLedger, ...childNetworkLedger].filter(
  (entry) => !entry.allowed,
).length;
const providerReceipt =
  mode === "deterministic-mock"
    ? (() => {
        const diagnostics = scenarioResult.modelFixtureDiagnostics;
        if (
          !diagnostics ||
          scenarioResult.modelFixtureMode !== "strict-fixtures"
        ) {
          throw new Error("scenario did not retain strict fixture diagnostics");
        }
        const fixtures = diagnostics.fixtures ?? [];
        const reasons = (diagnostics.unexpectedCalls ?? []).map(
          (call) => (call as { matchingReason?: unknown }).matchingReason,
        );
        return {
          fixtureMode: "strict-fixtures",
          fixtureManifestFingerprint: fixtureFingerprint,
          scenarioFingerprint,
          worldFingerprint,
          unmatchedCalls: reasons.filter(
            (reason) => reason === "no fixture matched",
          ).length,
          ambiguousCalls: reasons.filter(
            (reason) => reason === "multiple fixtures matched",
          ).length,
          responseLessCalls: reasons.filter(
            (reason) => reason === "matched fixture did not return a response",
          ).length,
          unusedRequiredFixtures: fixtures.filter(
            (fixture) => fixture.required && fixture.consumed < fixture.min,
          ).length,
          overconsumedFixtures:
            reasons.filter(
              (reason) => reason === "all matching fixtures were over-consumed",
            ).length +
            fixtures.filter(
              (fixture) =>
                fixture.max !== "unbounded" && fixture.consumed > fixture.max,
            ).length,
          diagnostics,
        };
      })()
    : {
        receiptType: "eliza.stability.real-llm.v1",
        provider,
        model,
        liveModelInvoked: (modelProxy?.requestCount() ?? 0) > 0,
        namespace,
        manifestId,
        generation,
        scenarioFingerprint,
        worldFingerprint,
        unexpectedRealServiceCalls: unexpectedEgress,
        unexpectedNetworkCalls: unexpectedEgress,
      };
const ledger = {
  network: { parentAndProxy: networkLedger, child: childNetworkLedger },
  mockServices: {
    hetznerServers: stack.mocks.hetzner.store.servers.size,
    controlPlaneUrl: stack.urls.controlPlane,
    providerProxyRequests: modelProxy?.requestCount() ?? 0,
    operations: mockOperations,
  },
  actionCount: actions.length,
  stateTransitionCount: transitions.length,
  ambientServiceLogEvidence,
  initialStateHash,
  cliCode,
  runtime: childRuntimeLedger,
  quiescence: {
    ...childQuiescenceLedger,
    naturalExitLatencyMs,
    unexpectedActiveHandles,
    activeRequests,
  },
};
await writeFile(
  path.join(outputDir, "mock-service-ledger.json"),
  JSON.stringify(ledger, null, 2),
  { encoding: "utf8", mode: 0o600 },
);

const passed =
  cliCode === 0 &&
  scenarioResult.status === "passed" &&
  actions.length >= 2 &&
  deniedRuntimeAdmissions.length === 0 &&
  ambientRealServices.length === 0 &&
  ambientServiceLogEvidence === 0 &&
  runtimeErrors.length === 0 &&
  unexpectedActiveHandles.length === 0 &&
  activeRequests.length === 0 &&
  Number.isFinite(naturalExitLatencyMs) &&
  naturalExitLatencyMs >= 0 &&
  naturalExitLatencyMs <= 5_000 &&
  unexpectedEgress === 0 &&
  mockOperations.some(
    (operation) =>
      operation.service === "hetzner" &&
      operation.method === "POST" &&
      operation.path === "/servers" &&
      operation.status === 201,
  ) &&
  mockOperations.some(
    (operation) =>
      operation.service === "hetzner" &&
      operation.method === "GET" &&
      /^\/servers\/\d+$/.test(operation.path) &&
      operation.status === 200,
  ) &&
  mockOperations.some(
    (operation) =>
      operation.service === "hetzner" &&
      operation.method === "DELETE" &&
      /^\/servers\/\d+$/.test(operation.path) &&
      operation.status === 200,
  );
const finalStateHash = createHash("sha256")
  .update(JSON.stringify({ actions, transitions }))
  .digest("hex");
process.stdout.write(
  JSON.stringify({
    passed,
    initialStateHash,
    finalStateHash,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: actions.length,
    evidence: {
      trajectory: turns,
      toolReceipts: actions,
      stateTransitions: transitions,
      providerReceipts: [providerReceipt],
      judgeVerdicts: [{ passed, scenarioStatus: scenarioResult.status }],
    },
    stateDiff: ledger,
    ...(passed
      ? {}
      : { error: `scenario failed with code ${String(cliCode)}` }),
  }),
);
