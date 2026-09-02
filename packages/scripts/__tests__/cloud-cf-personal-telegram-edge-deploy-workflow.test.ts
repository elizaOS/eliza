/**
 * Guards the migration-safe Personal Shared Telegram edge cutover: exact
 * Worker and gateway source proof, protected activation, and rollback.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../../", import.meta.url);
const source = readFileSync(
  new URL(
    ".github/workflows/activate-personal-shared-telegram-edge.yml",
    repoRoot,
  ),
  "utf8",
);

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<
        string,
        {
          default?: string | boolean;
          options?: string[];
          required?: boolean;
          type?: string;
        }
      >;
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      concurrency?: Record<string, string | boolean>;
      environment?: string;
      env?: Record<string, string>;
      needs?: string;
      steps?: WorkflowStep[];
    }
  >;
}

const workflow = Bun.YAML.parse(source) as Workflow;
const validation = workflow.jobs?.["validate-request"];
const job = workflow.jobs?.cutover;
const authorization = workflow.jobs?.["authorize-target"];
const steps = job?.steps ?? [];
const validationSteps = validation?.steps ?? [];

function step(name: string): WorkflowStep {
  const found = [...validationSteps, ...steps].find(
    (candidate) => candidate.name === name,
  );
  if (!found?.run) throw new Error(`Missing executable workflow step: ${name}`);
  return found;
}

function index(name: string): number {
  return steps.findIndex((candidate) => candidate.name === name);
}

function validateTarget(
  overrides: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  const validation = step("Validate protected target and production approval");
  return Bun.spawnSync(["bash", "-c", validation.run ?? ""], {
    env: {
      ...process.env,
      DESIRED_ENABLED: "true",
      EDGE_SECRET_NAME: "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED",
      EXPECTED_BRANCH: "develop",
      EXPECTED_SOURCE_SHA: "a".repeat(40),
      GATEWAY_URL: "https://gateway-webhook-stg-staging.up.railway.app",
      GITHUB_REF: "refs/heads/develop",
      GITHUB_REPOSITORY: "elizaOS/eliza",
      HEALTH_URL: "https://api-staging.eliza.app/api/health",
      PRODUCTION_APPROVAL_COMMENT_URL: "",
      REQUESTED_ENVIRONMENT: "staging",
      TARGET_ENVIRONMENT: "staging",
      ...overrides,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
}

function validateProductionApproval(
  author: string,
  approvalLine: string,
): ReturnType<typeof Bun.spawnSync> {
  const mockRoot = mkdtempSync(join(tmpdir(), "edge-approval-"));
  const responsePath = join(mockRoot, "comment.json");
  const ghPath = join(mockRoot, "gh");
  writeFileSync(
    responsePath,
    JSON.stringify({ body: approvalLine, user: { login: author } }),
  );
  writeFileSync(ghPath, '#!/bin/sh\ncat "$MOCK_GH_RESPONSE"\n');
  chmodSync(ghPath, 0o755);

  try {
    return validateTarget({
      EDGE_SECRET_NAME:
        "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED",
      EXPECTED_BRANCH: "main",
      GATEWAY_URL: "https://gateway-webhook-production.up.railway.app",
      GITHUB_REF: "refs/heads/main",
      HEALTH_URL: "https://api.eliza.app/api/health",
      MOCK_GH_RESPONSE: responsePath,
      PATH: `${mockRoot}:${process.env.PATH ?? ""}`,
      PRODUCTION_APPROVAL_COMMENT_URL:
        "https://github.com/elizaOS/eliza/issues/20877#issuecomment-123",
      REQUESTED_ENVIRONMENT: "production",
      TARGET_ENVIRONMENT: "production",
    });
  } finally {
    rmSync(mockRoot, { force: true, recursive: true });
  }
}

function verifyGatewayProof(
  options: { activeDeploymentId?: string; receiptSourceSha?: string } = {},
): ReturnType<typeof Bun.spawnSync> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "edge-gateway-proof-"));
  const binRoot = join(fixtureRoot, "bin");
  const receiptPath = join(fixtureRoot, "gateway-webhook-deployment.json");
  const activePath = join(fixtureRoot, "active.json");
  const outputPath = join(fixtureRoot, "github-output.txt");
  const sourceSha = "a".repeat(40);
  const deploymentId = "11111111-1111-4111-8111-111111111111";
  const serviceId = "22222222-2222-4222-8222-222222222222";
  const environmentId = "33333333-3333-4333-8333-333333333333";
  const projectId = "44444444-4444-4444-8444-444444444444";
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(
    receiptPath,
    JSON.stringify({
      sourceSha: options.receiptSourceSha ?? sourceSha,
      environment: "staging",
      deploymentId,
      service: "gateway-webhook-stg",
      telegramIdentity: "attested",
    }),
  );
  writeFileSync(
    activePath,
    JSON.stringify({
      id: serviceId,
      name: "gateway-webhook-stg",
      deploymentId: options.activeDeploymentId ?? deploymentId,
      status: "SUCCESS",
      stopped: false,
    }),
  );
  writeFileSync(
    join(binRoot, "gh"),
    `#!/bin/sh
set -eu
if [ "$1" = "api" ]; then
  printf '{"workflow_runs":[{"id":123,"head_sha":"%s","status":"completed","conclusion":"success"}]}' "$EXPECTED_SOURCE_SHA"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  shift 2
  destination=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--dir" ]; then
      destination="$2"
      shift 2
    else
      shift
    fi
  done
  mkdir -p "$destination"
  cp "$MOCK_RECEIPT" "$destination/gateway-webhook-deployment.json"
  exit 0
fi
exit 2
`,
  );
  writeFileSync(
    join(binRoot, "railway"),
    `#!/bin/sh
set -eu
if [ "$1" = "service" ] && [ "$2" = "status" ]; then
  cat "$MOCK_ACTIVE"
  exit 0
fi
exit 2
`,
  );
  writeFileSync(
    join(binRoot, "curl"),
    `#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) output="$2"; shift 2 ;;
    -w|--write-out|-m|--max-time) shift 2 ;;
    -s|-S|-sS|--silent|--show-error) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */health)
    printf '{"status":"healthy"}' > "$output"
    printf '200'
    ;;
  */ready/forwarder-auth/eliza-app)
    printf '{"error":"unauthorized","project":"eliza-app","status":"enforced"}' > "$output"
    printf '401'
    ;;
  */ready/telegram-identity/eliza-app)
    printf '{"project":"eliza-app","status":"attested"}' > "$output"
    printf '200'
    ;;
  *) exit 2 ;;
esac
`,
  );
  for (const command of ["gh", "railway", "curl"]) {
    chmodSync(join(binRoot, command), 0o755);
  }

  try {
    return Bun.spawnSync(
      [
        "bash",
        "-c",
        step("Verify exact active gateway before enable").run ?? "",
      ],
      {
        env: {
          ...process.env,
          EXPECTED_BRANCH: "develop",
          EXPECTED_GATEWAY_SERVICE_NAME: "gateway-webhook-stg",
          EXPECTED_SOURCE_SHA: sourceSha,
          GATEWAY_URL: "https://gateway.example",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "elizaOS/eliza",
          MOCK_ACTIVE: activePath,
          MOCK_RECEIPT: receiptPath,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
          RAILWAY_ENVIRONMENT_ID: environmentId,
          RAILWAY_PROJECT_ID: projectId,
          RAILWAY_SERVICE_ID: serviceId,
          RAILWAY_TOKEN: "fixture-token",
          RUNNER_TEMP: fixtureRoot,
          TARGET_ENVIRONMENT: "staging",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function exerciseFailedActivationRollback(): ReturnType<typeof Bun.spawnSync> {
  const mockRoot = mkdtempSync(join(tmpdir(), "edge-rollback-"));
  const rollbackMarker = join(mockRoot, "rollback-attempted");
  const executable = (name: string, body: string): void => {
    const path = join(mockRoot, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  executable("bunx", "exit 0");
  executable("sleep", "exit 0");
  executable("node", 'touch "$MOCK_ROLLBACK_MARKER"');
  executable(
    "railway",
    `printf '%s' '{"id":"22222222-2222-4222-8222-222222222222","name":"gateway-webhook-stg","deploymentId":"11111111-1111-4111-8111-111111111111","status":"SUCCESS","stopped":false}'`,
  );
  executable(
    "curl",
    `output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
printf '%s' '{"status":"ok","environment":"staging","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","personalSharedTelegramEdge":{"enabled":false}}' > "$output"
printf '200'`,
  );

  try {
    const result = Bun.spawnSync(
      ["bash", "-c", step("Apply and verify served edge state").run ?? ""],
      {
        cwd: fileURLToPath(new URL("packages/cloud/api/", repoRoot)),
        env: {
          ...process.env,
          DESIRED_ENABLED: "true",
          EDGE_SECRET_NAME: "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED",
          EXPECTED_GATEWAY_DEPLOYMENT_ID:
            "11111111-1111-4111-8111-111111111111",
          EXPECTED_GATEWAY_SERVICE_NAME: "gateway-webhook-stg",
          EXPECTED_SOURCE_SHA: "a".repeat(40),
          GITHUB_WORKSPACE: fileURLToPath(repoRoot),
          HEALTH_URL: "https://api-staging.eliza.app/api/health",
          MOCK_ROLLBACK_MARKER: rollbackMarker,
          PATH: `${mockRoot}:${process.env.PATH ?? ""}`,
          RAILWAY_ENVIRONMENT_ID: "33333333-3333-4333-8333-333333333333",
          RAILWAY_PROJECT_ID: "44444444-4444-4444-8444-444444444444",
          RAILWAY_SERVICE_ID: "22222222-2222-4222-8222-222222222222",
          TARGET_ENVIRONMENT: "staging",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(existsSync(rollbackMarker)).toBe(true);
    return result;
  } finally {
    rmSync(mockRoot, { force: true, recursive: true });
  }
}

function exerciseUnavailableDisableProof(): ReturnType<typeof Bun.spawnSync> {
  const mockRoot = mkdtempSync(join(tmpdir(), "edge-disable-proof-"));
  const removalMarker = join(mockRoot, "secret-removal-attempted");
  const executable = (name: string, body: string): void => {
    const path = join(mockRoot, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  executable("node", 'touch "$MOCK_REMOVAL_MARKER"');
  executable("curl", "exit 1");
  executable("sleep", "exit 0");

  try {
    const result = Bun.spawnSync(
      ["bash", "-c", step("Apply and verify served edge state").run ?? ""],
      {
        cwd: fileURLToPath(new URL("packages/cloud/api/", repoRoot)),
        env: {
          ...process.env,
          DESIRED_ENABLED: "false",
          EDGE_SECRET_NAME: "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED",
          EXPECTED_SOURCE_SHA: "a".repeat(40),
          GITHUB_WORKSPACE: fileURLToPath(repoRoot),
          HEALTH_URL: "https://api-staging.eliza.app/api/health",
          MOCK_REMOVAL_MARKER: removalMarker,
          PATH: `${mockRoot}:${process.env.PATH ?? ""}`,
          TARGET_ENVIRONMENT: "staging",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    if (!existsSync(removalMarker)) {
      throw new Error(
        "disable did not attempt secret removal before health proof",
      );
    }
    return result;
  } finally {
    rmSync(mockRoot, { force: true, recursive: true });
  }
}

describe("Personal Shared Telegram edge deploy", () => {
  test("authorizes before entering one protected mutation lock and canonical endpoint set", () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs;
    expect(inputs?.environment).toEqual({
      description: "Protected environment whose edge gate will be changed",
      required: true,
      default: "staging",
      type: "choice",
      options: ["staging", "production"],
    });
    expect(inputs?.production_approval_comment_url?.required).toBe(false);
    const protectedEnvironment =
      "${{ inputs.environment == 'production' && 'production' || 'staging' }}";
    expect(authorization?.environment).toBe(protectedEnvironment);
    expect(authorization?.concurrency).toBeUndefined();
    expect(authorization?.needs).toBe("validate-request");
    expect(job?.environment).toBe(protectedEnvironment);
    expect(job?.needs).toBe("authorize-target");
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      issues: "read",
    });
    expect(job?.concurrency?.group).toBe(
      "cloud-cf-release-v6-${{ inputs.environment == 'production' && 'production' || 'staging' }}",
    );
    expect(job?.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(job?.concurrency?.queue).toBe("max");
    expect(job?.env?.REQUESTED_ENVIRONMENT).toBe("${{ inputs.environment }}");
    expect(job?.env?.TARGET_ENVIRONMENT).toBe(
      "${{ inputs.environment == 'production' && 'production' || 'staging' }}",
    );
    expect(job?.env?.EXPECTED_BRANCH).toBe(
      "${{ inputs.environment == 'production' && 'main' || 'develop' }}",
    );
    expect(job?.env?.EDGE_SECRET_NAME).toBe(
      "${{ inputs.environment == 'production' && 'PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED' || 'PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED' }}",
    );
    expect(job?.env?.HEALTH_URL).toBe(
      "${{ inputs.environment == 'production' && 'https://api.eliza.app/api/health' || 'https://api-staging.eliza.app/api/health' }}",
    );
    expect(job?.env?.GATEWAY_URL).toBe(
      "${{ inputs.environment == 'production' && 'https://gateway-webhook-production.up.railway.app' || 'https://gateway-webhook-stg-staging.up.railway.app' }}",
    );
    expect(job?.env?.EXPECTED_GATEWAY_SERVICE_NAME).toBe(
      "${{ inputs.environment == 'production' && 'gateway-webhook' || 'gateway-webhook-stg' }}",
    );
    expect(job?.env?.RAILWAY_PROJECT_ID).toBe("${{ vars.RAILWAY_PROJECT_ID }}");
    expect(job?.env?.RAILWAY_ENVIRONMENT_ID).toBe(
      "${{ vars.RAILWAY_ENVIRONMENT_ID }}",
    );
    expect(job?.env?.RAILWAY_SERVICE_ID).toBe(
      "${{ vars.RAILWAY_SERVICE_ID_GATEWAY_WEBHOOK }}",
    );
    expect(job?.env?.RAILWAY_TOKEN).toBe("${{ secrets.RAILWAY_TOKEN }}");
  });

  test("rejects cross-environment selectors before any Worker or secret operation", () => {
    expect(validateTarget().exitCode).toBe(0);
    for (const overrides of [
      {
        EDGE_SECRET_NAME:
          "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED",
      },
      { EXPECTED_BRANCH: "main" },
      { HEALTH_URL: "https://api.eliza.app/api/health" },
      {
        GATEWAY_URL: "https://gateway-webhook-production.up.railway.app",
      },
      {
        PRODUCTION_APPROVAL_COMMENT_URL:
          "https://github.com/elizaOS/eliza/issues/20877#issuecomment-1",
      },
      { REQUESTED_ENVIRONMENT: "production" },
    ]) {
      expect(validateTarget(overrides).exitCode).not.toBe(0);
    }

    expect(
      validateTarget({
        EDGE_SECRET_NAME:
          "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED",
        EXPECTED_BRANCH: "main",
        GATEWAY_URL: "https://gateway-webhook-production.up.railway.app",
        GITHUB_REF: "refs/heads/main",
        HEALTH_URL: "https://api.eliza.app/api/health",
        TARGET_ENVIRONMENT: "production",
      }).exitCode,
    ).not.toBe(0);
  });

  test("requires a NubsCarson production approval bound to source and desired state", () => {
    const validation = step(
      "Validate protected target and production approval",
    );
    expect(validation.run).toContain(
      "^https://github\\.com/elizaOS/eliza/(issues|pull)/[0-9]+#issuecomment-([0-9]+)$",
    );
    expect(validation.run).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/issues/comments/$approval_comment_id"',
    );
    expect(validation.run).toContain('.user.login == "NubsCarson"');
    expect(validation.run).toContain(
      "[production-telegram-edge] APPROVE source=$EXPECTED_SOURCE_SHA enabled=$DESIRED_ENABLED",
    );

    const approval =
      "[production-telegram-edge] APPROVE source=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa enabled=true";
    expect(validateProductionApproval("NubsCarson", approval).exitCode).toBe(0);
    expect(
      validateProductionApproval("someone-else", approval).exitCode,
    ).not.toBe(0);
    expect(
      validateProductionApproval(
        "NubsCarson",
        "[production-telegram-edge] APPROVE source=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb enabled=true",
      ).exitCode,
    ).not.toBe(0);
  });

  test("proves exact served Worker and same-environment gateway sources before enable", () => {
    const ordered = [
      "Validate exact served Worker source before enable",
      "Install pinned Railway CLI",
      "Verify exact active gateway before enable",
      "Apply and verify served edge state",
      "Write cutover summary",
    ].map(index);
    expect(ordered.every((value) => value >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));

    const worker = step("Validate exact served Worker source before enable");
    expect(worker.if).toBe("inputs.enabled == true");
    expect(worker.run).toContain("git merge-base --is-ancestor");
    expect(worker.run).toContain("canonical $EXPECTED_BRANCH history");
    expect(worker.run).toContain(".commit == $sha");
    expect(worker.run).toContain(".environment == $environment");
    expect(worker.run).toContain("personalSharedTelegramEdge.enabled");

    const gateway = step("Verify exact active gateway before enable");
    expect(gateway.id).toBe("gateway_proof");
    expect(gateway.if).toContain("inputs.enabled == true");
    expect(gateway.run).toContain(
      "actions/workflows/deploy-gateway-webhook.yml/runs",
    );
    expect(gateway.run).toContain("branch=$EXPECTED_BRANCH");
    expect(gateway.run).toContain(".[0].head_sha == $sha");
    expect(gateway.run).toContain('.[0].conclusion == "success"');
    expect(gateway.run).toContain('gh run download "$gateway_run_id"');
    expect(gateway.run).toContain(
      'artifact_name="gateway-webhook-deployment-$TARGET_ENVIRONMENT-$EXPECTED_SOURCE_SHA"',
    );
    expect(gateway.run).toContain(".sourceSha == $sha");
    expect(gateway.run).toContain(".environment == $environment");
    expect(gateway.run).toContain(".service == $service");
    expect(gateway.run).toContain("railway service status");
    expect(gateway.run).toContain(".deploymentId == $id");
    expect(
      gateway.run?.match(/^\s*assert_active_gateway (before|after)$/gm)?.length,
    ).toBe(2);
    expect(gateway.run).toContain("$GATEWAY_URL/health");
    expect(gateway.run).toContain("ready/forwarder-auth/eliza-app");
  });

  test("executes the active-deployment proof and fails closed on receipt or service drift", () => {
    expect(verifyGatewayProof().exitCode).toBe(0);
    expect(
      verifyGatewayProof({
        activeDeploymentId: "55555555-5555-4555-8555-555555555555",
      }).exitCode,
    ).not.toBe(0);
    expect(
      verifyGatewayProof({ receiptSourceSha: "b".repeat(40) }).exitCode,
    ).not.toBe(0);
  });

  test("mutates only the selected environment binding and rolls every unproven exit back off", () => {
    const apply = step("Apply and verify served edge state");
    expect(apply.env?.EXPECTED_GATEWAY_DEPLOYMENT_ID).toContain(
      "steps.gateway_proof.outputs.deployment_id",
    );
    expect(apply.run).toContain("wrangler@4.116.0 secret put");
    expect(apply.run).toContain(
      '"$EDGE_SECRET_NAME" --env "$TARGET_ENVIRONMENT"',
    );
    expect(apply.run).toContain("ensure-worker-secret-absent.mjs");
    expect(apply.run).toContain("prove_edge_disabled");
    expect(apply.run).toContain(".personalSharedTelegramEdge.enabled == false");
    expect(apply.run).toContain("trap rollback_on_unproven_exit EXIT");
    expect(apply.run).toContain("railway service status");
    expect(apply.run).toContain(".deploymentId == $id");
    expect(apply.run).toContain("assert_active_gateway before");
    expect(apply.run).toContain("assert_active_gateway after");
    expect(apply.run).toContain(".commit == $sha");
    expect(apply.run).toContain(
      ".personalSharedTelegramEdge.enabled == $enabled",
    );
    expect(apply.run).toContain("if disable_edge; then");
    expect(apply.run).not.toContain('grep -qi "not found"');
    expect(apply.run).not.toContain("--env staging");
    expect(apply.run).not.toContain("--env production");
    expect(apply.run).not.toContain(
      "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED --env",
    );
    expect(apply.run).not.toContain(
      "PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED --env",
    );

    const rollback = exerciseFailedActivationRollback();
    expect(rollback.exitCode).not.toBe(0);
    expect(rollback.stdout.toString()).toContain("staging was rolled back off");
  });

  test("authorized disable removes first and reports unavailable served-off proof distinctly", () => {
    const worker = step("Validate exact served Worker source before enable");
    expect(worker.if).toBe("inputs.enabled == true");

    const unavailable = exerciseUnavailableDisableProof();
    expect(unavailable.exitCode).not.toBe(0);
    expect(unavailable.stdout.toString()).toContain(
      "edge secret removal was confirmed, but served-off proof is unavailable",
    );
  });

  test("keeps the legacy guard false and reserves both environment-pinned activation secret names", () => {
    const config = Bun.TOML.parse(
      readFileSync(
        new URL("packages/cloud/api/wrangler.toml", repoRoot),
        "utf8",
      ),
    ) as {
      vars?: Record<string, string>;
      env?: Record<string, { vars?: Record<string, string> }>;
    };
    expect(config.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED).toBe("false");
    expect(
      config.env?.staging?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.production?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED,
    ).toBe("false");
    expect(
      config.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.staging?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.production?.vars
        ?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED,
    ).toBeUndefined();
    expect(
      config.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.staging?.vars
        ?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.production?.vars
        ?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED,
    ).toBeUndefined();
  });
});
