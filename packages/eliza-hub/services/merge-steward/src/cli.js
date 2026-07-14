#!/usr/bin/env node

import { createMergeStewardClient } from "./client.js";
import { renderQueueComment } from "./comments.js";
import { loadConfig, validateRuntimeConfig } from "./config.js";
import { runDeploymentDoctor } from "./deployment-doctor.js";
import { buildDomainEvidence } from "./domain-evidence.js";
import { buildGithubParityMatrix } from "./github-parity.js";
import { evaluateMergePolicy, scheduleQueue } from "./policy.js";
import { validateProductionGateArtifactSources } from "./production-artifact-sources.js";
import { validateProductionEvidenceFreshness } from "./production-evidence-freshness.js";
import { buildProductionEvidenceTemplate } from "./production-evidence-template.js";
import { runProductionGate } from "./production-gate.js";
import {
  buildProductionCutoverPlan,
  buildProductionReadiness,
} from "./production-readiness.js";
import { buildRunnerIsolationAudit } from "./runner-isolation.js";
import { createSteward } from "./server.js";
import { buildValidationPlan } from "./validation-plan.js";
import { runQueueWorker } from "./worker.js";

const command = process.argv[2] ?? "help";
const commandArgs = process.argv.slice(3);

try {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  const input = await readStdinJson();
  const config = loadConfig();

  if (command === "evaluate") {
    printJson({
      decision: evaluateMergePolicy(input.item ?? input, config.policy),
    });
  } else if (command === "schedule") {
    printJson({ queue: scheduleQueue(input.items ?? [], config.policy) });
  } else if (command === "comment") {
    printJson({ comment: renderQueueComment(input) });
  } else if (command === "preflight") {
    const preflight = withCheckedAt(validateRuntimeConfig(config));
    printJson({ preflight });
    if (!preflight.ok) process.exitCode = 1;
  } else if (command === "doctor") {
    const doctor = await runDeploymentDoctor({
      baseUrl: process.argv[3] ?? input.baseUrl,
      token:
        process.env.MERGE_STEWARD_DOCTOR_TOKEN ??
        process.env[config.apiAuth?.tokenEnv],
      requireMetrics: parseBoolean(
        process.env.MERGE_STEWARD_DOCTOR_REQUIRE_METRICS,
        true,
      ),
      requireProductApis: parseBoolean(
        process.env.MERGE_STEWARD_DOCTOR_REQUIRE_PRODUCT_APIS,
        true,
      ),
      smokeRepo: process.env.MERGE_STEWARD_SMOKE_REPO ?? input.smokeRepo,
      smokeAgent: process.env.MERGE_STEWARD_SMOKE_AGENT ?? input.smokeAgent,
    });
    printJson({ doctor });
    if (!doctor.ok) process.exitCode = 1;
  } else if (command === "discovery-summary") {
    const client = createMergeStewardClient({
      baseUrl:
        commandArgs[0] ??
        input.baseUrl ??
        process.env.MERGE_STEWARD_URL ??
        process.env.ELIZA_MERGE_STEWARD_URL,
    });
    printJson({ discoverySummary: await client.getDiscoverySummary() });
  } else if (command === "github-parity") {
    const evidence = input.evidence ?? input;
    const hasEvidence = Object.keys(objectValue(evidence) ?? {}).length > 0;
    const productionGate = hasEvidence
      ? withOptionalProductionChecks(
          runProductionGate({ evidence }),
          evidence,
          {
            strict: hasFlag(commandArgs, "--strict"),
          },
        )
      : null;
    const parity = buildGithubParityMatrix({
      evidence: hasEvidence ? evidence : null,
      productionGate,
    });
    printJson({ parity });
    if (hasEvidence && !parity.summary.cutoverReady) process.exitCode = 1;
  } else if (command === "production-gate") {
    const evidence = input.evidence ?? input;
    const productionGate = withOptionalProductionChecks(
      runProductionGate({ evidence }),
      evidence,
      {
        strict: hasFlag(commandArgs, "--strict"),
      },
    );
    printJson({ productionGate });
    if (!productionGate.ok) process.exitCode = 1;
  } else if (command === "production-readiness") {
    const evidence = input.evidence ?? input;
    const hasEvidence = Object.keys(objectValue(evidence) ?? {}).length > 0;
    const productionGate = hasEvidence
      ? withOptionalProductionChecks(
          runProductionGate({ evidence }),
          evidence,
          {
            strict: hasFlag(commandArgs, "--strict"),
          },
        )
      : null;
    const productionReadiness = buildProductionReadiness({
      evidence: hasEvidence ? evidence : null,
      productionGate,
    });
    printJson({ productionReadiness });
    if (hasEvidence && !productionReadiness.productionReady)
      process.exitCode = 1;
  } else if (command === "production-cutover") {
    const evidence = input.evidence ?? input;
    const hasEvidence = Object.keys(objectValue(evidence) ?? {}).length > 0;
    const productionGate = hasEvidence
      ? withOptionalProductionChecks(
          runProductionGate({ evidence }),
          evidence,
          {
            strict: hasFlag(commandArgs, "--strict"),
          },
        )
      : null;
    const productionCutover = buildProductionCutoverPlan({
      evidence: hasEvidence ? evidence : null,
      productionGate,
    });
    printJson({ productionCutover });
    if (hasEvidence && !productionCutover.productionReady) process.exitCode = 1;
  } else if (command === "production-evidence-template") {
    printJson({
      productionEvidenceTemplate: buildProductionEvidenceTemplate(),
    });
  } else if (command === "domain-evidence") {
    const domainEvidence = await buildDomainEvidence({
      forgejoRootUrl:
        process.argv[3] ??
        input.forgejoRootUrl ??
        input.domain?.forgejoRootUrl ??
        process.env.FORGEJO_ROOT_URL,
      forgejoDomain:
        input.forgejoDomain ??
        input.domain?.forgejoDomain ??
        process.env.FORGEJO_DOMAIN,
      reverseProxyReviewed: parseBoolean(
        input.reverseProxyReviewed ??
          input.domain?.reverseProxyReviewed ??
          process.env.FORGEJO_REVERSE_PROXY_REVIEWED,
        false,
      ),
    });
    printJson({ domainEvidence });
    if (domainEvidence.status === "blocked") process.exitCode = 1;
  } else if (command === "runner-isolation") {
    const runnerIsolation = buildRunnerIsolationAudit(
      input.runnerIsolation ?? input,
    );
    printJson({ runnerIsolation });
    if (!runnerIsolation.productionReady) process.exitCode = 1;
  } else if (command === "validation-plan") {
    const validationPlan = buildValidationPlan(
      normalizeValidationPlanInput(input),
    );
    printJson({ validationPlan });
    if (!validationPlan.decision.allowed) process.exitCode = 1;
  } else if (command === "agent-identities") {
    printJson({
      agentIdentities: await runAgentIdentitiesCommand({
        input,
        args: commandArgs,
        config,
      }),
    });
  } else if (command === "worker") {
    const preflight = validateRuntimeConfig(config);
    if (!preflight.ok) {
      printJson({ preflight });
      process.exit(1);
    }
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    process.once("SIGTERM", () => abort.abort());
    printJson({
      worker: await runQueueWorker({
        steward: createSteward({ config }),
        config,
        signal: abort.signal,
      }),
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  // error-policy:J1 CLI process boundary: report the failure on stderr and exit
  // non-zero
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown error"}\n`,
  );
  process.exit(1);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  return JSON.parse(raw);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeValidationPlanInput(input) {
  const payload = objectValue(input.validationPlan) ?? objectValue(input) ?? {};
  const item = objectValue(payload.item) ?? objectValue(payload.queueItem);

  if (!item) return payload;

  return {
    ...payload,
    queueItem: payload.queueItem ?? item,
    repo: payload.repo ?? item.repo,
    ownerAgentId: payload.ownerAgentId ?? item.ownerAgentId,
    changedFiles: payload.changedFiles ?? item.changedFiles,
    affectedPackages: payload.affectedPackages ?? item.affectedPackages,
  };
}

async function runAgentIdentitiesCommand({ input = {}, args = [], config }) {
  const action = args[0] ?? input.action ?? "list";
  const client = createMergeStewardClient({
    baseUrl: args[1] ?? input.baseUrl ?? process.env.MERGE_STEWARD_URL,
    token:
      input.token ??
      process.env.MERGE_STEWARD_AGENT_IDENTITIES_TOKEN ??
      process.env.MERGE_STEWARD_API_TOKEN ??
      process.env.MERGE_STEWARD_TOKEN ??
      process.env.ELIZA_MERGE_STEWARD_TOKEN ??
      process.env.MERGE_STEWARD_DOCTOR_TOKEN ??
      process.env[config.apiAuth?.tokenEnv],
  });

  if (action === "list") {
    return client.listAgentIdentities(input.query ?? agentIdentityQuery(input));
  }

  if (action === "sync") {
    const agents = normalizeAgentIdentitySyncInput(input, config);
    const synced = [];
    let summary = null;
    for (const agent of agents) {
      const result = await client.upsertAgentIdentity({
        agent,
        registeredBy:
          input.registeredBy ?? input.operatorId ?? "eliza-merge-steward-cli",
      });
      synced.push(result.agent);
      summary = result.summary ?? summary;
    }
    return {
      synced: synced.length,
      agents: synced,
      summary,
    };
  }

  if (action === "disable") {
    const id = args[2] ?? input.id ?? input.agentId;
    if (!id) {
      throw new Error("agent-identities disable requires id or agentId");
    }
    return client.disableAgentIdentity({
      id,
      reason: input.reason,
      disabledBy:
        input.disabledBy ?? input.operatorId ?? "eliza-merge-steward-cli",
    });
  }

  throw new Error(`Unknown agent-identities action: ${action}`);
}

function normalizeAgentIdentitySyncInput(input = {}, config = {}) {
  const explicitAgents = Array.isArray(input)
    ? input
    : (input.agents ??
      input.agentIdentities ??
      (input.agent ? [input.agent] : null));
  const agents =
    explicitAgents ??
    (config.policy?.knownAgentIds ?? []).map((id) => ({
      id,
      source: "env-bootstrap",
    }));
  return agents.map((agent) => {
    if (typeof agent === "string")
      return { id: agent, source: input.source ?? "cli" };
    return {
      ...agent,
      source: agent.source ?? input.source ?? "cli",
    };
  });
}

function agentIdentityQuery(input = {}) {
  return {
    status: input.status,
    tenantId: input.tenantId,
    source: input.source,
  };
}

function withCheckedAt(result, now = new Date()) {
  return {
    ...result,
    checkedAt: now.toISOString(),
  };
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function withOptionalProductionChecks(
  productionGate,
  evidence,
  { strict = false } = {},
) {
  const extraChecks = [];

  if (
    strict ||
    parseBoolean(process.env.PRODUCTION_GATE_VALIDATE_ARTIFACTS, false)
  ) {
    extraChecks.push(validateProductionGateArtifactSources(evidence));
  }

  if (
    strict ||
    parseBoolean(process.env.PRODUCTION_GATE_VALIDATE_FRESHNESS, false)
  ) {
    extraChecks.push(
      validateProductionEvidenceFreshness(evidence, {
        now: process.env.PRODUCTION_GATE_NOW ?? new Date(),
      }),
    );
  }

  if (extraChecks.length === 0) {
    return productionGate;
  }

  const checks = [...productionGate.checks, ...extraChecks];
  const failed = checks.filter((check) => !check.ok).length;

  return {
    ...productionGate,
    ok: productionGate.evidenceShape.ok && failed === 0,
    summary: {
      ...productionGate.summary,
      total: checks.length,
      passed: checks.length - failed,
      failed,
    },
    checks,
  };
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function printHelp() {
  process.stdout.write(`Eliza Merge Steward

Usage:
  eliza-merge-steward evaluate < item.json
  eliza-merge-steward schedule < items.json
  eliza-merge-steward comment < decision.json
  eliza-merge-steward preflight
  eliza-merge-steward doctor <base-url>
  eliza-merge-steward discovery-summary <base-url>
  eliza-merge-steward github-parity [--strict] < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
  eliza-merge-steward domain-evidence <forgejo-root-url>
  eliza-merge-steward production-gate [--strict] < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
  eliza-merge-steward production-readiness [--strict] < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
  eliza-merge-steward production-cutover [--strict] < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
  eliza-merge-steward production-evidence-template
  eliza-merge-steward runner-isolation < runner-evidence.json
  eliza-merge-steward validation-plan < validation-request.json
  eliza-merge-steward agent-identities list <base-url>
  eliza-merge-steward agent-identities sync <base-url> < agents.json
  eliza-merge-steward agent-identities disable <base-url> < agent.json
  eliza-merge-steward worker

Commands:
  evaluate  Evaluate one queue item and return a merge decision.
  schedule  Filter and order queue items.
  comment   Render a short structured steward comment.
  preflight Validate runtime configuration for deployment startup.
  doctor    Check health, readiness, discovery, OpenAPI, metrics, and product APIs on a deployed steward.
  discovery-summary
            Fetch public discovery and print normalized auth, route, surface, agent policy, and merge execution hints.
  github-parity
            Print the GitHub/Forgejo/Eliza parity matrix, optionally scored against private production evidence.
  domain-evidence
            Probe Forgejo domain/TLS and emit the production evidence domain block.
  production-gate
            Evaluate production launch evidence against the hard readiness gate. Use --strict to re-read artifacts and validate freshness.
  production-readiness
            Render the launch checklist, optionally scored against private evidence. Use --strict to include the full production cutover gate.
  production-cutover
            Render the ordered cutover plan, optionally scored against private evidence. Use --strict to include artifact and freshness checks.
  production-evidence-template
            Print a schema-valid, non-passing production evidence template for private operator state.
  runner-isolation
            Convert runner config and launch attestations into production-gate evidence.
  validation-plan
            Classify proposed validation commands and fail on broad runner-expensive work.
  agent-identities
            List, sync, or disable steward-managed allowed agent identities on a deployed service.
  worker    Run the merge queue worker loop.
`);
}
