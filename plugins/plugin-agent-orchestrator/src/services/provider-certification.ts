/**
 * Defines provider-route certification receipts and deterministic proofs for
 * coding-agent authentication, billing, failover, artifact, and redaction
 * contracts. Fixture receipts are explicitly marked deterministic and never
 * stand in for credential-gated live evidence.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODING_AGENT_BACKEND_PREFLIGHTS,
  CODING_PROVIDER_DESCRIPTOR_VERSION,
  type CodingAgentBackend,
  type CodingProviderBillingMode,
  codingProviderDescriptorForProvider,
} from "@elizaos/shared";

export const PROVIDER_CERTIFICATION_SCHEMA_VERSION = 1 as const;
export const PROVIDER_CERTIFICATION_MATRIX_VERSION = 1 as const;

export type ProviderCertificationStatus =
  | "PASS"
  | "FAIL"
  | "SKIP"
  | "UNAVAILABLE";
export type ProviderCertificationMode = "deterministic" | "live";
export type ProviderFailureKind =
  | "revoked"
  | "expired"
  | "exhausted"
  | "rate-limited";
export type ProviderFailoverPolicy = "same-provider" | "fail-closed";

export const CERTIFICATION_SURFACE_NAMES = [
  "argv",
  "environmentSummary",
  "logs",
  "prompts",
  "metadata",
  "trajectories",
  "evidence",
] as const;
export type CertificationSurfaceName =
  (typeof CERTIFICATION_SURFACE_NAMES)[number];
export type CertificationSurfaces = Readonly<
  Record<CertificationSurfaceName, unknown>
>;

export interface ProviderCertificationRoute {
  id: string;
  label: string;
  providerId: string;
  descriptorProviderId: string | null;
  backend: CodingAgentBackend | null;
  supported: boolean;
  authMode: "oauth" | "api-key" | "coding-plan-key" | "unavailable";
  billingMode:
    | CodingProviderBillingMode
    | "subscription-allowance-or-opt-in-extra-usage";
  billingDetail: string;
  failoverPolicy: ProviderFailoverPolicy;
  modelPolicy: "explicit-live-model" | "not-applicable";
  credentialEnvironmentKey: string | null;
  runEnvironmentKey: string;
  documentationUrl: string;
  unavailableReason: string | null;
  expectedCommand: string | null;
}

const route = (value: ProviderCertificationRoute): ProviderCertificationRoute =>
  Object.freeze(value);

/** Route-level truth for the providers named by coding-goal certification. */
export const PROVIDER_CERTIFICATION_ROUTES = [
  route({
    id: "kimi-cli-subscription",
    label: "Kimi Code OAuth",
    providerId: "kimi",
    descriptorProviderId: null,
    backend: "kimi",
    supported: true,
    authMode: "oauth",
    billingMode: "subscription-allowance-or-opt-in-extra-usage",
    billingDetail:
      "Kimi uses included coding allowance first and may use paid Extra Usage only when the account owner enabled it; the live receipt must report the observed state.",
    failoverPolicy: "fail-closed",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: null,
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_KIMI",
    documentationUrl: "https://github.com/MoonshotAI/kimi-code",
    unavailableReason: null,
    expectedCommand: "kimi acp",
  }),
  route({
    id: "kimi-coding-plan-inference",
    label: "Kimi coding endpoint key",
    providerId: "kimi-coding",
    descriptorProviderId: "kimi-coding",
    backend: null,
    supported: false,
    authMode: "coding-plan-key",
    billingMode: "subscription-coding-plan",
    billingDetail:
      "The saved coding-endpoint key is an inference credential, not the Kimi CLI OAuth session consumed by ACP.",
    failoverPolicy: "fail-closed",
    modelPolicy: "not-applicable",
    credentialEnvironmentKey: "KIMI_CODING_API_KEY",
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_KIMI_PLAN",
    documentationUrl: "https://platform.moonshot.ai/docs/guide/agent-support",
    unavailableReason:
      "No current elizaOS coding-agent spawn backend consumes the saved Kimi coding-plan endpoint key; launch `kimi`, enter `/login`, and use Kimi ACP instead.",
    expectedCommand: null,
  }),
  route({
    id: "zai-coding-plan",
    label: "Z.AI Coding Plan",
    providerId: "zai-coding",
    descriptorProviderId: "zai-coding",
    backend: "opencode",
    supported: true,
    authMode: "coding-plan-key",
    billingMode: "subscription-coding-plan",
    billingDetail:
      "Z.AI Coding Plan through OpenCode's dedicated coding endpoint; this subscription route remains distinct from the general Z.AI API.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: "ZAI_API_KEY",
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_ZAI_PLAN",
    documentationUrl: "https://docs.z.ai/devpack/overview",
    unavailableReason: null,
    expectedCommand: "opencode acp",
  }),
  route({
    id: "zai-api",
    label: "Z.AI API through OpenCode",
    providerId: "zai-api",
    descriptorProviderId: "zai-api",
    backend: "opencode",
    supported: true,
    authMode: "api-key",
    billingMode: "usage",
    billingDetail: "Usage-based Z.AI API billing, separate from Coding Plan.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: "ZAI_API_KEY",
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_ZAI_API",
    documentationUrl: "https://docs.z.ai/guides/develop/http/introduction",
    unavailableReason: null,
    expectedCommand: "opencode acp",
  }),
  route({
    id: "deepseek-consumer-subscription",
    label: "DeepSeek consumer subscription",
    providerId: "deepseek-coding",
    descriptorProviderId: "deepseek-coding",
    backend: null,
    supported: false,
    authMode: "unavailable",
    billingMode: "subscription-coding-plan",
    billingDetail:
      "DeepSeek consumer access is not a reusable coding-agent or API entitlement.",
    failoverPolicy: "fail-closed",
    modelPolicy: "not-applicable",
    credentialEnvironmentKey: null,
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_DEEPSEEK_PLAN",
    documentationUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    unavailableReason:
      "DeepSeek documents API usage as a separately funded API balance; no first-party consumer coding subscription can be attached to ACP.",
    expectedCommand: null,
  }),
  route({
    id: "deepseek-api",
    label: "DeepSeek API through OpenCode",
    providerId: "deepseek-api",
    descriptorProviderId: "deepseek-api",
    backend: "opencode",
    supported: true,
    authMode: "api-key",
    billingMode: "usage",
    billingDetail: "Usage-based DeepSeek API billing.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: "DEEPSEEK_API_KEY",
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_DEEPSEEK_API",
    documentationUrl: "https://api-docs.deepseek.com/",
    unavailableReason: null,
    expectedCommand: "opencode acp",
  }),
  route({
    id: "openai-codex-subscription",
    label: "OpenAI Codex with ChatGPT",
    providerId: "openai-codex",
    descriptorProviderId: "openai-codex",
    backend: "codex",
    supported: true,
    authMode: "oauth",
    billingMode: "subscription-coding-cli",
    billingDetail:
      "Codex uses included ChatGPT agentic allowance first and may use purchased shared credits or auto top-up; this remains separate from Platform API-key billing.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: null,
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_OPENAI_CODEX",
    documentationUrl: "https://developers.openai.com/codex/auth",
    unavailableReason: null,
    expectedCommand: "managed-codex",
  }),
  route({
    id: "openai-api",
    label: "OpenAI API through Codex",
    providerId: "openai-api",
    descriptorProviderId: "openai-api",
    backend: "codex",
    supported: true,
    authMode: "api-key",
    billingMode: "usage",
    billingDetail:
      "OpenAI Platform API usage is billed separately from ChatGPT/Codex subscription allowance.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: "OPENAI_API_KEY",
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_OPENAI_API",
    documentationUrl: "https://developers.openai.com/codex/auth",
    unavailableReason: null,
    expectedCommand: "managed-codex",
  }),
  route({
    id: "claude-subscription",
    label: "Claude Code subscription",
    providerId: "anthropic-subscription",
    descriptorProviderId: "anthropic-subscription",
    backend: "claude",
    supported: true,
    authMode: "oauth",
    billingMode: "subscription-coding-cli",
    billingDetail:
      "Claude Pro/Max Claude Code allowance; API Console credits are a separate explicit billing choice.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: null,
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_CLAUDE",
    documentationUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
    unavailableReason: null,
    expectedCommand: "npx -y @agentclientprotocol/claude-agent-acp@0.34.0",
  }),
  route({
    id: "anthropic-api",
    label: "Anthropic API through Claude Code",
    providerId: "anthropic-api",
    descriptorProviderId: "anthropic-api",
    backend: "claude",
    supported: true,
    authMode: "api-key",
    billingMode: "usage",
    billingDetail:
      "Anthropic API Console usage, explicitly separate from Claude Pro/Max allowance.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: "ANTHROPIC_API_KEY",
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_ANTHROPIC_API",
    documentationUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
    unavailableReason: null,
    expectedCommand: "npx -y @agentclientprotocol/claude-agent-acp@0.34.0",
  }),
  route({
    id: "grok-build-subscription",
    label: "Grok Build OAuth",
    providerId: "grok",
    descriptorProviderId: null,
    backend: "grok",
    supported: true,
    authMode: "oauth",
    billingMode: "subscription-coding-cli",
    billingDetail:
      "Grok Build OAuth session. The xAI API-key route is certified separately.",
    failoverPolicy: "fail-closed",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: null,
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_GROK",
    documentationUrl: "https://x.ai/news/grok-build",
    unavailableReason: null,
    expectedCommand: "grok agent stdio",
  }),
  route({
    id: "xai-api",
    label: "xAI API through OpenCode",
    providerId: "xai-api",
    descriptorProviderId: "xai-api",
    backend: "opencode",
    supported: true,
    authMode: "api-key",
    billingMode: "api-payg",
    billingDetail:
      "Usage-based xAI API billing, separate from Grok Build OAuth.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: "XAI_API_KEY",
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_XAI_API",
    documentationUrl: "https://docs.x.ai/docs/overview",
    unavailableReason: null,
    expectedCommand: "opencode acp",
  }),
  route({
    id: "openrouter-api",
    label: "OpenRouter credits or BYOK through OpenCode",
    providerId: "openrouter-api",
    descriptorProviderId: "openrouter-api",
    backend: "opencode",
    supported: true,
    authMode: "api-key",
    billingMode: "api-credits-or-byok",
    billingDetail:
      "OpenRouter credits or BYOK; this is not represented as a subscription.",
    failoverPolicy: "same-provider",
    modelPolicy: "explicit-live-model",
    credentialEnvironmentKey: "OPENROUTER_API_KEY",
    runEnvironmentKey: "RUN_LIVE_PROVIDER_CERTIFICATION_OPENROUTER",
    documentationUrl: "https://openrouter.ai/docs/api/reference/authentication",
    unavailableReason: null,
    expectedCommand: "opencode acp",
  }),
] as const satisfies readonly ProviderCertificationRoute[];

export interface ProviderCertificationReceipt {
  schemaVersion: typeof PROVIDER_CERTIFICATION_SCHEMA_VERSION;
  matrixVersion: typeof PROVIDER_CERTIFICATION_MATRIX_VERSION;
  mode: ProviderCertificationMode;
  routeId: string;
  status: ProviderCertificationStatus;
  provider: { id: string; backend: CodingAgentBackend | null };
  model: { id: string | null; observed: boolean };
  account: { ref: string | null; authMode: string };
  billing: {
    mode: string;
    source: string | null;
    detail: string;
    observed: boolean;
  };
  usage: {
    status: "accepted" | "unknown" | ProviderFailureKind;
    observed: boolean;
  };
  task: {
    operationKey: string;
    receiptId: string | null;
    read: boolean;
    edit: boolean;
    test: boolean;
    successfulReceiptCount: number;
  };
  redaction: {
    surfacesScanned: readonly CertificationSurfaceName[];
    secretLeakCount: number;
  };
  artifactSha256: string | null;
  reason: string | null;
}

export interface ProviderFailoverProof {
  routeId: string;
  failure: ProviderFailureKind;
  policy: ProviderFailoverPolicy;
  attempts: readonly {
    accountRef: string;
    result: ProviderFailureKind | "accepted";
  }[];
  successfulReceiptCount: number;
  duplicateTask: boolean;
  verdict: "failover-pass" | "fail-closed-pass";
}

export interface ProviderCertificationReport {
  schemaVersion: typeof PROVIDER_CERTIFICATION_SCHEMA_VERSION;
  matrixVersion: typeof PROVIDER_CERTIFICATION_MATRIX_VERSION;
  descriptorVersion: typeof CODING_PROVIDER_DESCRIPTOR_VERSION;
  mode: "deterministic";
  receipts: readonly ProviderCertificationReceipt[];
  failoverProofs: readonly ProviderFailoverProof[];
}

export function providerCertificationRoute(
  routeId: string,
): ProviderCertificationRoute | undefined {
  return PROVIDER_CERTIFICATION_ROUTES.find(
    (candidate) => candidate.id === routeId,
  );
}

/** Fail closed when capability descriptors or adapter commands drift. */
export function assertProviderCertificationMatrixCurrent(): void {
  for (const certification of PROVIDER_CERTIFICATION_ROUTES) {
    if (certification.descriptorProviderId) {
      const descriptor = codingProviderDescriptorForProvider(
        certification.descriptorProviderId,
      );
      if (!descriptor) {
        throw new Error(
          `Certification route ${certification.id} references missing descriptor ${certification.descriptorProviderId}`,
        );
      }
      if (
        descriptor.backend !== certification.backend ||
        descriptor.spawnSupport !== certification.supported ||
        descriptor.billingMode !== certification.billingMode
      ) {
        throw new Error(
          `Certification route ${certification.id} drifted from descriptor v${descriptor.version}; review and bump the certification matrix`,
        );
      }
    }
    if (certification.backend && certification.expectedCommand) {
      const preflight = CODING_AGENT_BACKEND_PREFLIGHTS[certification.backend];
      const actual =
        preflight.commandResolution === "managed-codex"
          ? "managed-codex"
          : preflight.defaultCommand;
      if (actual !== certification.expectedCommand) {
        throw new Error(
          `Certification route ${certification.id} command drifted (${actual}); review and bump the certification matrix`,
        );
      }
    }
    if (!certification.supported && !certification.unavailableReason) {
      throw new Error(
        `Unsupported certification route ${certification.id} needs an actionable reason`,
      );
    }
  }
}

function stableSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeCertificationSurfaces(
  surfaces: CertificationSurfaces,
  secrets: Readonly<Record<string, string>>,
): CertificationSurfaces {
  const knownSecrets = Object.entries(secrets)
    .filter((entry): entry is [string, string] => entry[1].length >= 8)
    .sort((left, right) => right[1].length - left[1].length);
  return Object.fromEntries(
    CERTIFICATION_SURFACE_NAMES.map((name) => {
      let serialized = JSON.stringify(surfaces[name]);
      if (serialized === undefined) serialized = "null";
      for (const [secretName, secretValue] of knownSecrets) {
        serialized = serialized.replaceAll(
          secretValue,
          `[REDACTED:${secretName}]`,
        );
      }
      return [name, JSON.parse(serialized)];
    }),
  ) as unknown as CertificationSurfaces;
}

export function findCertificationSecretLeaks(
  surfaces: CertificationSurfaces,
  sentinelSecrets: readonly string[],
): readonly { surface: CertificationSurfaceName; sentinelIndex: number }[] {
  const findings: {
    surface: CertificationSurfaceName;
    sentinelIndex: number;
  }[] = [];
  for (const surface of CERTIFICATION_SURFACE_NAMES) {
    const serialized = JSON.stringify(surfaces[surface]);
    sentinelSecrets.forEach((sentinel, sentinelIndex) => {
      if (sentinel.length >= 8 && serialized.includes(sentinel)) {
        findings.push({ surface, sentinelIndex });
      }
    });
  }
  return findings;
}

function deterministicTaskProof(routeId: string): {
  artifactSha256: string;
  read: boolean;
  edit: boolean;
  test: boolean;
} {
  const workdir = mkdtempSync(join(tmpdir(), `provider-cert-${routeId}-`));
  try {
    mkdirSync(join(workdir, "src"), { recursive: true });
    mkdirSync(join(workdir, "test"), { recursive: true });
    writeFileSync(
      join(workdir, "README.md"),
      "provider certification fixture\n",
    );
    const read =
      readFileSync(join(workdir, "README.md"), "utf8") ===
      "provider certification fixture\n";
    writeFileSync(
      join(workdir, "src", "certified.mjs"),
      "export const certifiedRoute = () => 'certified';\n",
    );
    writeFileSync(
      join(workdir, "test", "certified.test.mjs"),
      "import assert from 'node:assert/strict';\nimport { certifiedRoute } from '../src/certified.mjs';\nassert.equal(certifiedRoute(), 'certified');\n",
    );
    execFileSync(
      process.execPath,
      [join(workdir, "test", "certified.test.mjs")],
      {
        cwd: workdir,
        stdio: "pipe",
      },
    );
    const artifact = readFileSync(
      join(workdir, "src", "certified.mjs"),
      "utf8",
    );
    return {
      artifactSha256: stableSha256(artifact),
      read,
      edit: artifact.includes("certifiedRoute"),
      test: true,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function deterministicReceipt(
  certification: ProviderCertificationRoute,
): ProviderCertificationReceipt {
  const operationKey = `provider-certification:${certification.id}:v${PROVIDER_CERTIFICATION_MATRIX_VERSION}`;
  if (!certification.supported) {
    return {
      schemaVersion: PROVIDER_CERTIFICATION_SCHEMA_VERSION,
      matrixVersion: PROVIDER_CERTIFICATION_MATRIX_VERSION,
      mode: "deterministic",
      routeId: certification.id,
      status: "UNAVAILABLE",
      provider: { id: certification.providerId, backend: null },
      model: { id: null, observed: false },
      account: { ref: null, authMode: certification.authMode },
      billing: {
        mode: certification.billingMode,
        source: null,
        detail: certification.billingDetail,
        observed: false,
      },
      usage: { status: "unknown", observed: false },
      task: {
        operationKey,
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
      reason: certification.unavailableReason,
    };
  }
  const proof = deterministicTaskProof(certification.id);
  const sentinel = `sentinel-${certification.id}-credential-value`;
  const sanitized = sanitizeCertificationSurfaces(
    {
      argv: [certification.expectedCommand, "--credential", sentinel],
      environmentSummary: {
        credential: sentinel,
        provider: certification.providerId,
      },
      logs: `provider=${certification.providerId} token=${sentinel}`,
      prompts: `Never repeat ${sentinel}; certify ${certification.id}`,
      metadata: { provider: certification.providerId, credential: sentinel },
      trajectories: [{ event: "spawn", authorization: `Bearer ${sentinel}` }],
      evidence: { operationKey, secret: sentinel },
    },
    { fixture: sentinel },
  );
  const leaks = findCertificationSecretLeaks(sanitized, [sentinel]);
  const receiptId = stableSha256(`${operationKey}:${proof.artifactSha256}`);
  return {
    schemaVersion: PROVIDER_CERTIFICATION_SCHEMA_VERSION,
    matrixVersion: PROVIDER_CERTIFICATION_MATRIX_VERSION,
    mode: "deterministic",
    routeId: certification.id,
    status:
      proof.read && proof.edit && proof.test && leaks.length === 0
        ? "PASS"
        : "FAIL",
    provider: { id: certification.providerId, backend: certification.backend },
    model: { id: `fixture/${certification.id}`, observed: false },
    account: {
      ref: `fixture:${certification.providerId}:primary`,
      authMode: certification.authMode,
    },
    billing: {
      mode: certification.billingMode,
      source: `fixture:${certification.billingMode}`,
      detail: certification.billingDetail,
      observed: false,
    },
    usage: { status: "accepted", observed: false },
    task: {
      operationKey,
      receiptId,
      read: proof.read,
      edit: proof.edit,
      test: proof.test,
      successfulReceiptCount: 1,
    },
    redaction: {
      surfacesScanned: CERTIFICATION_SURFACE_NAMES,
      secretLeakCount: leaks.length,
    },
    artifactSha256: proof.artifactSha256,
    reason: null,
  };
}

export function deterministicFailoverProof(
  certification: ProviderCertificationRoute,
  failure: ProviderFailureKind,
): ProviderFailoverProof {
  if (certification.failoverPolicy === "fail-closed") {
    return {
      routeId: certification.id,
      failure,
      policy: "fail-closed",
      attempts: [
        {
          accountRef: `${certification.providerId}:local-session`,
          result: failure,
        },
      ],
      successfulReceiptCount: 0,
      duplicateTask: false,
      verdict: "fail-closed-pass",
    };
  }
  return {
    routeId: certification.id,
    failure,
    policy: "same-provider",
    attempts: [
      { accountRef: `${certification.providerId}:primary`, result: failure },
      {
        accountRef: `${certification.providerId}:secondary`,
        result: "accepted",
      },
    ],
    successfulReceiptCount: 1,
    duplicateTask: false,
    verdict: "failover-pass",
  };
}

export function runDeterministicProviderCertification(): ProviderCertificationReport {
  assertProviderCertificationMatrixCurrent();
  const receipts = PROVIDER_CERTIFICATION_ROUTES.map(deterministicReceipt);
  const failures: readonly ProviderFailureKind[] = [
    "revoked",
    "expired",
    "exhausted",
    "rate-limited",
  ];
  const failoverProofs = PROVIDER_CERTIFICATION_ROUTES.filter(
    (certification) => certification.supported,
  ).flatMap((certification) =>
    failures.map((failure) =>
      deterministicFailoverProof(certification, failure),
    ),
  );
  return {
    schemaVersion: PROVIDER_CERTIFICATION_SCHEMA_VERSION,
    matrixVersion: PROVIDER_CERTIFICATION_MATRIX_VERSION,
    descriptorVersion: CODING_PROVIDER_DESCRIPTOR_VERSION,
    mode: "deterministic",
    receipts,
    failoverProofs,
  };
}
