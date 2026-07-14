#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProductionReadiness } from "../../../services/merge-steward/src/production-readiness.js";
import { artifactPath, elizaArtifactRoot } from "./artifact-paths.mjs";

const EVIDENCE_KEYS = Object.freeze([
  "domain",
  "sso",
  "backups",
  "database",
  "imageProvenance",
  "runner",
  "repository",
  "githubMigration",
  "secrets",
  "mail",
  "storage",
  "observability",
  "steward",
  "mergeQueueRollout",
  "securityReview",
  "deployment",
]);

const EXPECTED_FRAGMENTS = Object.freeze(
  [
    ["domain_tls", "domain", "domain-evidence.json"],
    ["sso_registration", "sso", "sso-evidence.json"],
    ["backup_restore", "backups", "backup-evidence.json"],
    ["database_migration", "database", "database-evidence.json"],
    ["image_provenance", "imageProvenance", "image-provenance.json"],
    ["runner_isolation", "runner", "eliza-hub-runner-production-evidence.json"],
    ["repository_protection", "repository", "repository-evidence.json"],
    [
      "github_migration_rehearsal",
      "githubMigration",
      "eliza-hub-pilot-bootstrap-evidence.json",
    ],
    ["secret_management", "secrets", "secret-management.json"],
    ["mail_notifications", "mail", "mail-evidence.json"],
    ["storage_retention", "storage", "storage-evidence.json"],
    ["observability", "observability", "observability-evidence.json"],
    ["steward_runtime", "steward", "steward-evidence.json"],
    [
      "merge_queue_rollout",
      "mergeQueueRollout",
      "merge-queue-rollout-evidence.json",
    ],
    ["security_review", "securityReview", "security-review-evidence.json"],
    ["deployment_verification", "deployment", "eliza-hub-deploy-evidence.json"],
  ].map(([domainId, evidenceBlock, filename]) =>
    Object.freeze({ domainId, evidenceBlock, filename }),
  ),
);

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(usage());
      return;
    }

    const inventory = buildInventory(options);
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);

    if (options.strict && !inventory.complete) {
      console.error(
        `[production-evidence-inventory] incomplete: ${inventory.summary.missing + inventory.summary.invalid + inventory.summary.wrongBlock} fragment(s) need attention`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[production-evidence-inventory] error: ${error.message}`);
    process.exitCode = 1;
  }
}

function buildInventory(options) {
  const artifactRoot = path.resolve(
    options.artifactRoot ?? elizaArtifactRoot(),
  );
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const readiness = buildProductionReadiness({ generatedAt });
  const domainsById = new Map(
    readiness.domains.map((domain) => [domain.id, domain]),
  );
  const fragments = EXPECTED_FRAGMENTS.map((expected) =>
    inspectExpectedFragment(expected, {
      artifactRoot,
      domainsById,
    }),
  );
  const summary = summarizeFragments(fragments);
  const complete =
    summary.missing === 0 && summary.invalid === 0 && summary.wrongBlock === 0;
  const nextActionFragment =
    fragments.find((fragment) => fragment.status !== "present") ?? null;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const template =
    options.template ??
    path.resolve(
      scriptDir,
      "..",
      "release",
      "production-evidence.example.json",
    );
  const out =
    options.out ??
    artifactPath("eliza-hub-production-evidence.json", {
      ELIZA_ARTIFACT_ROOT: artifactRoot,
    });

  return {
    schema: "https://eliza.hub/schemas/production-evidence-inventory.v1",
    inventoryVersion: 1,
    generatedAt,
    artifactRoot,
    complete,
    summary,
    nextAction: nextActionFragment
      ? {
          domainId: nextActionFragment.domainId,
          evidenceBlock: nextActionFragment.evidenceBlock,
          status: nextActionFragment.status,
          expectedPath: nextActionFragment.expectedPath,
          helper: nextActionFragment.helper,
          helperSteps: nextActionFragment.helperSteps,
          reason: nextActionFragment.error ?? nextActionFragment.status,
        }
      : null,
    assemble: {
      ready: complete,
      command: shellJoin([
        relativeScriptPath(scriptDir, "production-evidence-assemble.mjs"),
        "--template",
        template,
        "--out",
        out,
        ...fragments.map((fragment) => fragment.expectedPath),
      ]),
      template,
      out,
      fragmentPaths: fragments.map((fragment) => fragment.expectedPath),
    },
    fragments,
  };
}

function inspectExpectedFragment(expected, { artifactRoot, domainsById }) {
  const expectedPath = path.join(artifactRoot, expected.filename);
  const domain = domainsById.get(expected.domainId) ?? {};
  const base = {
    domainId: expected.domainId,
    title: domain.title ?? null,
    evidenceBlock: expected.evidenceBlock,
    expectedPath,
    file: null,
    helper: domain.helper ?? null,
    helperSteps: Array.isArray(domain.helperSteps) ? domain.helperSteps : [],
    exists: existsSync(expectedPath),
    validJson: false,
    supportedBlocks: [],
    containsExpectedBlock: false,
    status: "missing",
  };

  if (!base.exists) {
    return base;
  }

  const file = fileProvenance(expectedPath);
  const parsed = readJson(expectedPath);
  if (!parsed.ok) {
    return {
      ...base,
      file,
      status: "invalid_json",
      error: parsed.error,
    };
  }

  const updates = evidenceUpdates(parsed.value);
  const supportedBlocks = Object.keys(updates);
  const containsExpectedBlock = supportedBlocks.includes(
    expected.evidenceBlock,
  );

  return {
    ...base,
    file,
    validJson: true,
    supportedBlocks,
    containsExpectedBlock,
    status: containsExpectedBlock ? "present" : "wrong_block",
    ...(containsExpectedBlock
      ? {}
      : {
          error: `expected ${expected.evidenceBlock} evidence block`,
        }),
  };
}

function evidenceUpdates(fragment) {
  const updates = {};

  if (fragment?.domainEvidence?.domain) {
    updates.domain = fragment.domainEvidence.domain;
  }

  if (fragment?.runnerIsolation?.evidence?.runner) {
    updates.runner = {
      smokeEvidence: null,
      auditEvidence: null,
      ...fragment.runnerIsolation.evidence.runner,
    };
  }

  if (fragment?.schema === "https://eliza.hub/schemas/deploy-evidence.v1") {
    updates.deployment = {};
  }

  if (
    fragment?.schema === "https://eliza.hub/schemas/pilot-bootstrap-evidence.v1"
  ) {
    updates.githubMigration = {};
  }

  for (const key of EVIDENCE_KEYS) {
    if (Object.hasOwn(fragment ?? {}, key)) {
      updates[key] = fragment[key];
    }
  }

  return updates;
}

function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` };
  }
}

function summarizeFragments(fragments) {
  const filesWithDigest = fragments.filter(
    (fragment) => fragment.file?.sha256,
  ).length;

  return {
    total: fragments.length,
    present: fragments.filter((fragment) => fragment.status === "present")
      .length,
    missing: fragments.filter((fragment) => fragment.status === "missing")
      .length,
    invalid: fragments.filter((fragment) => fragment.status === "invalid_json")
      .length,
    wrongBlock: fragments.filter(
      (fragment) => fragment.status === "wrong_block",
    ).length,
    filesWithDigest,
    evidenceBlocks: fragments.map((fragment) => fragment.evidenceBlock),
  };
}

function fileProvenance(filePath) {
  const body = readFileSync(filePath);
  const stat = statSync(filePath);

  return {
    sizeBytes: stat.size,
    sha256: createHash("sha256").update(body).digest("hex"),
    modifiedAt: stat.mtime.toISOString(),
  };
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--strict") {
      options.strict = true;
      continue;
    }

    if (arg === "--artifact-root") {
      index += 1;
      if (!args[index]) throw new Error("--artifact-root requires a path");
      options.artifactRoot = args[index];
      continue;
    }

    if (arg.startsWith("--artifact-root=")) {
      options.artifactRoot = requireValue(arg, "--artifact-root=");
      continue;
    }

    if (arg === "--template") {
      index += 1;
      if (!args[index]) throw new Error("--template requires a path");
      options.template = args[index];
      continue;
    }

    if (arg.startsWith("--template=")) {
      options.template = requireValue(arg, "--template=");
      continue;
    }

    if (arg === "--out") {
      index += 1;
      if (!args[index]) throw new Error("--out requires a path");
      options.out = args[index];
      continue;
    }

    if (arg.startsWith("--out=")) {
      options.out = requireValue(arg, "--out=");
      continue;
    }

    if (arg === "--generated-at") {
      index += 1;
      if (!args[index])
        throw new Error("--generated-at requires an ISO timestamp");
      options.generatedAt = args[index];
      continue;
    }

    if (arg.startsWith("--generated-at=")) {
      options.generatedAt = requireValue(arg, "--generated-at=");
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function requireValue(arg, prefix) {
  const value = arg.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

function relativeScriptPath(scriptDir, scriptName) {
  return (
    path.relative(process.cwd(), path.join(scriptDir, scriptName)) || scriptName
  );
}

function shellJoin(args) {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function usage() {
  return `Usage: production-evidence-inventory.mjs [--artifact-root PATH] [--template PATH] [--out PATH] [--generated-at ISO] [--strict]

Reads the private artifact root and reports expected production evidence
fragments before assembly. This is an inventory and shape preflight only; the
strict production gate remains authoritative for launch readiness.

Default artifact root:
  $ELIZA_ARTIFACT_ROOT, XDG state, or ~/.local/state/eliza-hub/artifacts

The report includes:
  - each expected fragment path
  - whether it exists and parses as JSON
  - which production evidence blocks it contains
  - the next helper command and helperSteps from production readiness
  - the production-evidence-assemble.mjs command to run when complete

Use --strict to exit non-zero until every expected fragment exists and contains
its expected production evidence block.
`;
}
