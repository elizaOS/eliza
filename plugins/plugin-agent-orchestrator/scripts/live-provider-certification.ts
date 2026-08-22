/**
 * Runs one explicitly selected provider route against the native ACP live
 * smoke and writes a redacted structured receipt. Missing opt-in, credentials,
 * local login, model pins, or executables are SKIP/UNAVAILABLE, never success.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CERTIFICATION_SURFACE_NAMES,
  findCertificationSecretLeaks,
  PROVIDER_CERTIFICATION_MATRIX_VERSION,
  PROVIDER_CERTIFICATION_ROUTES,
  PROVIDER_CERTIFICATION_SCHEMA_VERSION,
  type ProviderCertificationReceipt,
  providerCertificationRoute,
  sanitizeCertificationSurfaces,
} from "../src/services/provider-certification.js";

const outputIndex = process.argv.indexOf("--output");
const output =
  outputIndex >= 0 ? process.argv[outputIndex + 1]?.trim() : undefined;
if (outputIndex >= 0 && !output) {
  throw new Error("--output requires a destination path");
}

const operationKey = (routeId: string) =>
  `provider-live-certification:${routeId}:v${PROVIDER_CERTIFICATION_MATRIX_VERSION}`;

function baseReceipt(
  route: (typeof PROVIDER_CERTIFICATION_ROUTES)[number],
  status: ProviderCertificationReceipt["status"],
  reason: string,
): ProviderCertificationReceipt {
  return {
    schemaVersion: PROVIDER_CERTIFICATION_SCHEMA_VERSION,
    matrixVersion: PROVIDER_CERTIFICATION_MATRIX_VERSION,
    mode: "live",
    routeId: route.id,
    status,
    provider: { id: route.providerId, backend: route.backend },
    model: { id: null, observed: false },
    account: { ref: null, authMode: route.authMode },
    billing: {
      mode: route.billingMode,
      source: null,
      detail: route.billingDetail,
      observed: false,
    },
    usage: { status: "unknown", observed: false },
    task: {
      operationKey: operationKey(route.id),
      receiptId: null,
      read: false,
      edit: false,
      test: false,
      successfulReceiptCount: 0,
    },
    redaction: {
      surfacesScanned: CERTIFICATION_SURFACE_NAMES,
      secretLeakCount: 0,
    },
    artifactSha256: null,
    reason,
  };
}

function writeReport(value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (output) {
    const destination = resolve(output);
    writeFileSync(destination, serialized, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${destination}\n`);
    return;
  }
  process.stdout.write(serialized);
}

const selectedRouteId = process.env.LIVE_PROVIDER_ROUTE?.trim();
if (!selectedRouteId) {
  writeReport({
    schemaVersion: PROVIDER_CERTIFICATION_SCHEMA_VERSION,
    matrixVersion: PROVIDER_CERTIFICATION_MATRIX_VERSION,
    mode: "live",
    receipts: PROVIDER_CERTIFICATION_ROUTES.map((route) =>
      route.supported
        ? baseReceipt(
            route,
            "SKIP",
            `Set LIVE_PROVIDER_ROUTE=${route.id}, RUN_LIVE_PROVIDER_CERTIFICATION=1, and ${route.runEnvironmentKey}=1 to authorize this live route.`,
          )
        : baseReceipt(
            route,
            "UNAVAILABLE",
            route.unavailableReason ?? "Route is not supported.",
          ),
    ),
  });
  process.exit(0);
}

const selected = providerCertificationRoute(selectedRouteId);
if (!selected) {
  throw new Error(
    `Unknown LIVE_PROVIDER_ROUTE=${JSON.stringify(selectedRouteId)}; expected ${PROVIDER_CERTIFICATION_ROUTES.map((route) => route.id).join(", ")}`,
  );
}
if (!selected.supported) {
  writeReport({
    receipt: baseReceipt(
      selected,
      "UNAVAILABLE",
      selected.unavailableReason ?? "Route is not supported.",
    ),
  });
  process.exit(0);
}
if (
  process.env.RUN_LIVE_PROVIDER_CERTIFICATION !== "1" ||
  process.env[selected.runEnvironmentKey] !== "1"
) {
  writeReport({
    receipt: baseReceipt(
      selected,
      "SKIP",
      `Live provider work requires both RUN_LIVE_PROVIDER_CERTIFICATION=1 and ${selected.runEnvironmentKey}=1.`,
    ),
  });
  process.exit(0);
}

const model = process.env.LIVE_PROVIDER_MODEL?.trim();
if (!model) {
  writeReport({
    receipt: baseReceipt(
      selected,
      "UNAVAILABLE",
      "Set LIVE_PROVIDER_MODEL to the exact model being certified; implicit model drift is rejected.",
    ),
  });
  process.exit(0);
}
const billingChoices =
  selected.id === "kimi-cli-subscription"
    ? ["included-allowance", "extra-usage"]
    : selected.id === "openai-codex-subscription"
      ? ["included-agentic-allowance", "shared-credits", "auto-top-up"]
      : selected.billingMode === "subscription-coding-cli"
        ? ["subscription-allowance"]
        : [selected.billingMode];
const configuredBillingSource =
  process.env.LIVE_PROVIDER_BILLING_SOURCE?.trim();
if (
  billingChoices.length > 1 &&
  (!configuredBillingSource ||
    !billingChoices.includes(configuredBillingSource))
) {
  writeReport({
    receipt: baseReceipt(
      selected,
      "UNAVAILABLE",
      `Set LIVE_PROVIDER_BILLING_SOURCE to one of: ${billingChoices.join(", ")}. The harness will not guess which allowance or paid fallback served the task.`,
    ),
  });
  process.exit(0);
}
const billingSource = configuredBillingSource ?? billingChoices[0] ?? null;
const credential = selected.credentialEnvironmentKey
  ? process.env[selected.credentialEnvironmentKey]?.trim()
  : undefined;
if (selected.credentialEnvironmentKey && !credential) {
  writeReport({
    receipt: baseReceipt(
      selected,
      "UNAVAILABLE",
      `${selected.credentialEnvironmentKey} is not configured for this explicit live route.`,
    ),
  });
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "provider-live-cert-"));
const nativeReceiptPath = join(scratch, "native-receipt.json");
try {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    RUN_LIVE_NATIVE_ACP: "1",
    LIVE_NATIVE_ACP_AGENT: selected.backend ?? "",
    LIVE_NATIVE_ACP_CERTIFICATION: "1",
    LIVE_NATIVE_ACP_RECEIPT_PATH: nativeReceiptPath,
    LIVE_NATIVE_ACP_OPERATION_KEY: operationKey(selected.id),
    LIVE_NATIVE_ACP_CODEX_MODEL: model,
    LIVE_NATIVE_ACP_AUTH_MODE:
      selected.authMode === "api-key" ? "api-key" : "oauth",
    ELIZA_SUBSCRIPTION_EXECUTION_MODE: "user-attended",
  };
  if (selected.backend === "opencode") {
    childEnvironment.ELIZA_OPENCODE_ACP_COMMAND =
      process.env.ELIZA_OPENCODE_ACP_COMMAND?.trim() || "opencode acp";
    childEnvironment.ELIZA_OPENCODE_PROVIDER_ID = selected.providerId;
    childEnvironment.ELIZA_OPENCODE_MODEL_POWERFUL = model;
  }
  if (selected.backend === "claude") {
    childEnvironment.ELIZA_CLAUDE_ACP_COMMAND =
      process.env.ELIZA_CLAUDE_ACP_COMMAND?.trim() ||
      "npx -y @agentclientprotocol/claude-agent-acp@0.34.0";
    childEnvironment.ELIZA_CLAUDE_MODEL = model;
  }
  if (selected.backend === "kimi") {
    childEnvironment.ELIZA_KIMI_ACP_COMMAND =
      process.env.ELIZA_KIMI_ACP_COMMAND?.trim() || "kimi acp";
  }
  if (selected.backend === "grok") {
    childEnvironment.ELIZA_GROK_ACP_COMMAND =
      process.env.ELIZA_GROK_ACP_COMMAND?.trim() || "grok agent stdio";
  }
  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "..", "tests", "e2e", "live-native-acp-smoke.mjs")],
    {
      cwd: join(import.meta.dir, ".."),
      env: childEnvironment,
      encoding: "utf8",
      timeout: Number(process.env.LIVE_PROVIDER_TIMEOUT_MS ?? 240_000),
    },
  );
  const combinedLog = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  const secrets = credential
    ? { providerCredential: credential }
    : ({} as Record<string, string>);
  let nativeReceipt: {
    read?: boolean;
    edit?: boolean;
    test?: boolean;
    receiptId?: string;
    artifactSha256?: string;
  } = {};
  try {
    nativeReceipt = JSON.parse(readFileSync(nativeReceiptPath, "utf8"));
  } catch {
    // error-policy:J3 a missing/malformed child receipt is explicit live
    // failure or unavailable state below, never a healthy default.
    nativeReceipt = {};
  }
  const sanitized = sanitizeCertificationSurfaces(
    {
      argv: [selected.expectedCommand, "<live-native-acp>"],
      environmentSummary: {
        configuredKeys: Object.keys(childEnvironment).filter(
          (key) => key === selected.credentialEnvironmentKey,
        ),
      },
      logs: combinedLog,
      prompts: "read README; edit module and test; execute test",
      metadata: {
        routeId: selected.id,
        providerId: selected.providerId,
        backend: selected.backend,
        model,
      },
      trajectories: combinedLog,
      evidence: nativeReceipt,
    },
    secrets,
  );
  const leaks = findCertificationSecretLeaks(
    sanitized,
    credential ? [credential] : [],
  );
  const passed =
    child.status === 0 &&
    combinedLog.includes("NATIVE ACP SMOKE PASSED") &&
    nativeReceipt.read === true &&
    nativeReceipt.edit === true &&
    nativeReceipt.test === true &&
    leaks.length === 0;
  const skipped = combinedLog.includes("NATIVE ACP SMOKE SKIPPED");
  const failureStatus = /429|rate.?limit/iu.test(combinedLog)
    ? "rate-limited"
    : /quota|usage limit|exhausted/iu.test(combinedLog)
      ? "exhausted"
      : /expired/iu.test(combinedLog)
        ? "expired"
        : /revoked|401|unauthori[sz]ed/iu.test(combinedLog)
          ? "revoked"
          : "unknown";
  const receipt: ProviderCertificationReceipt = {
    ...baseReceipt(
      selected,
      passed ? "PASS" : skipped ? "UNAVAILABLE" : "FAIL",
      passed
        ? "Live native ACP completed the disposable read/edit/test task."
        : skipped
          ? "The live adapter reported missing runtime or authentication; inspect the redacted log."
          : "The live adapter did not produce a valid read/edit/test receipt.",
    ),
    model: { id: model, observed: false },
    account: {
      ref:
        selected.authMode === "api-key"
          ? `environment:${selected.credentialEnvironmentKey}`
          : `local-cli:${selected.providerId}`,
      authMode: selected.authMode,
    },
    billing: {
      mode: selected.billingMode,
      source: billingSource,
      detail: selected.billingDetail,
      observed: false,
    },
    usage: {
      status: passed ? "accepted" : failureStatus,
      observed: passed || failureStatus !== "unknown",
    },
    task: {
      operationKey: operationKey(selected.id),
      receiptId: nativeReceipt.receiptId ?? null,
      read: nativeReceipt.read === true,
      edit: nativeReceipt.edit === true,
      test: nativeReceipt.test === true,
      successfulReceiptCount: passed ? 1 : 0,
    },
    redaction: {
      surfacesScanned: CERTIFICATION_SURFACE_NAMES,
      secretLeakCount: leaks.length,
    },
    artifactSha256: nativeReceipt.artifactSha256 ?? null,
  };
  writeReport({ receipt, surfaces: sanitized });
  process.exitCode = passed || skipped ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
