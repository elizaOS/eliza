#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "live-test-inventory",
);
const DEFAULT_LIVE_TEST_RUNS_DIR = path.join(
  REPO_ROOT,
  "reports",
  "live-test-runs",
);
const SCRIPT_PATTERN = /live|real|e2e/i;
const KNOWN_ARTIFACT_SCRIPT_PATTERNS = [
  /scenario/i,
  /run-live-test-with-artifacts/i,
  /e2e:record/i,
  /remote-capabilities:.*artifacts/i,
  /remote-capabilities:.*reports/i,
];
const LIKELY_LLM_PATTERNS = [
  /llm/i,
  /ai/i,
  /agent/i,
  /chat/i,
  /voice/i,
  /capabilit/i,
  /cerebras/i,
  /openai/i,
  /anthropic/i,
  /groq/i,
  /model/i,
  /generation/i,
];
const NON_MODEL_EXCLUSION_RULES = [
  {
    reason: "Playwright/browser UI or visual audit suite; capture belongs to UI screenshots/traces rather than model-call trajectory artifacts.",
    matches: (row) => /playwright|run-ui-playwright|run-e2e|aesthetic-audit|contact-sheet|web-views|cloud-wallet|homepage|os-homepage|app-xr|llama-ui|packages\/test\/cloud-e2e/i.test(row.value),
  },
  {
    reason: "Repository/package test-lane aggregator; underlying leaf scripts are inventoried separately.",
    matches: (row) => /run-all-tests|test:cloud:full|test:cloud &&|--only=e2e|--filter=|--pattern|test:e2e:heavy|TEST_LANE=/i.test(row.value),
  },
  {
    reason: "Local plugin smoke harness; validates plugin bootstrapping/service wiring, not LLM token/cache behavior.",
    matches: (row) => /run-local-plugin-live-smoke|plugin-(discord|edge-tts|elizacloud|music|shopify|sql|telegram|workflow)/i.test(row.value),
  },
  {
    reason: "External device, hardware, OS, or mobile gateway validation; evidence is environment logs/device traces, not model-call artifacts.",
    matches: (row) => /bluebubbles|android-sms|riscv64|usb|virtual-usb|smartglasses|simulator|evenhub|sandbox-live|live-sandbox|mobile/i.test(row.value),
  },
  {
    reason: "Database, migration, SDK, or cloud integration test; real external state is exercised without LLM trajectory/cache semantics.",
    matches: (row) => /migration|integration|DATABASE|cloud-sdk|ELIZA_CLOUD_SDK_LIVE|cloud-api|feed|market-realism|sql tests|test:real|background-real|live-schedule|scheduled-task|reminder-review|lifeops-scheduling|schedule-merged/i.test(row.value),
  },
  {
    reason: "Template/example/component e2e wrapper; no provider/model terms in the script command.",
    matches: (row) => /templates\/plugin|examples\/_plugin|plugin-starter|__APP_PACKAGE_NAME__|test:component|test\.ts|vitest run src\/e2e/i.test(row.value),
  },
  {
    reason: "Static lint or package quality gate included by broad live/e2e name matching; not a runtime artifact source.",
    matches: (row) => /\blint\b|biome check|echo 'unit-only/i.test(row.value),
  },
  {
    reason: "Manual real/e2e plugin suite without model/provider terms; keep as non-model evidence unless a provider key is introduced.",
    matches: (row) => /test:e2e:manual|\.real\.e2e|\.live\.e2e|acp-codex-smoke|example-bluesky|plugin-(documents|shopify-ui|steward-app|task-coordinator|vincent|agent-orchestrator)/i.test(row.value),
  },
  {
    reason: "Package-local browser/unit/e2e bundle with no model/provider terms.",
    matches: (row) => /test:slow|vitest\.e2e|npx playwright test|npm run test:ui|npm run test:client|npm run test:unit/i.test(row.value),
  },
];

function excerpt(value, max = 900) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseArgs(argv) {
  const options = { reportDir: DEFAULT_REPORT_DIR, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--report-dir requires a value");
      options.reportDir = path.resolve(REPO_ROOT, next);
      i += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function packageJsonPaths() {
  const completed = spawnSync("rg", ["--files", "-g", "package.json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (completed.status !== 0) {
    throw new Error(completed.stderr || "failed to list package.json files");
  }
  return completed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (file) =>
        !file.includes("/node_modules/") &&
        !file.includes("/dist/") &&
        !file.includes("/build/"),
    )
    .sort();
}

function readPackage(file) {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8"));
  } catch {
    return null;
  }
}

function scriptKind(name, command) {
  const value = `${name} ${command}`;
  if (/e2e/i.test(value)) return "e2e";
  if (/live/i.test(value)) return "live";
  if (/real/i.test(value)) return "real";
  return "other";
}

function isLikelyLlmScript(name, command) {
  const value = `${name} ${command}`;
  return LIKELY_LLM_PATTERNS.some((pattern) => pattern.test(value));
}

function nonModelExclusion(row) {
  if (row.likelyLlm || row.hasArtifactEvidence) return null;
  const value = `${row.packageJson} ${row.packageName} ${row.script} ${row.command}`;
  const candidate = { ...row, value };
  const rule = NON_MODEL_EXCLUSION_RULES.find((entry) => entry.matches(candidate));
  return rule ? rule.reason : null;
}

function normalizeCommand(value) {
  return String(value || "")
    .replace(/^cd\s+(?:"[^"]+"|'[^']+'|[^&]+)\s*&&\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function commandText(command) {
  if (!Array.isArray(command)) return "";
  if (command[0] === "sh" && command[1] === "-lc" && command[2]) {
    return String(command[2]);
  }
  return command.join(" ");
}

function relFromReport(filePath, reportDir) {
  if (!filePath) return "";
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(REPO_ROOT, filePath);
  return path.relative(reportDir, absolute).replaceAll(path.sep, "/");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
      char
    ],
  );
}

function readWrappedRuns() {
  if (!existsSync(DEFAULT_LIVE_TEST_RUNS_DIR)) return [];
  const runs = [];
  for (const entry of readdirSync(DEFAULT_LIVE_TEST_RUNS_DIR, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const reportPath = path.join(
      DEFAULT_LIVE_TEST_RUNS_DIR,
      entry.name,
      "report.json",
    );
    if (!existsSync(reportPath)) continue;
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const structuredSummary = report.structuredLlmSummary || {};
      runs.push({
        label: String(report.label || entry.name),
        runDir: String(report.runDir || path.dirname(reportPath)),
        startedAt: String(report.startedAt || ""),
        completedAt: String(report.completedAt || ""),
        durationMs: Number(report.durationMs || 0),
        exitCode: Number(report.exitCode ?? -1),
        command: Array.isArray(report.command) ? report.command.map(String) : [],
        commandText: commandText(report.command),
        viewerIndex: String(report.artifactPaths?.viewerIndex || ""),
        playbackIndex: existsSync(path.join(path.dirname(reportPath), "playback.html"))
          ? path.join(path.dirname(reportPath), "playback.html")
          : "",
        llmCallsJsonl: String(report.artifactPaths?.llmCallsJsonl || ""),
        structuredLlmCallCount: Number(structuredSummary.callCount || 0),
        structuredTotalTokens: Number(structuredSummary.totalTokens || 0),
        structuredCacheReadInputTokens: Number(
          structuredSummary.cacheReadInputTokens || 0,
        ),
        stdoutExcerpt: excerpt(report.stdout),
        stderrExcerpt: excerpt(report.stderr),
        reportJson: reportPath,
      });
    } catch {
      // Keep malformed run folders intact for manual inspection.
    }
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function matchingWrappedRuns(row, wrappedRuns) {
  const rowCommand = normalizeCommand(row.command);
  const packageDir = path.dirname(row.packageJson || "");
  const rootScriptCommand = normalizeCommand(`bun run ${row.script}`);
  const cwdScriptCommand =
    packageDir && packageDir !== "."
      ? normalizeCommand(`bun run --cwd ${packageDir} ${row.script}`)
      : "";
  return wrappedRuns.filter((run) => {
    const runCommand = normalizeCommand(run.commandText);
    return (
      runCommand === rowCommand ||
      runCommand === rootScriptCommand ||
      (cwdScriptCommand && runCommand === cwdScriptCommand)
    );
  });
}

function suggestedAction(row) {
  if (row.modelArtifactRequired && row.structuredLlmCoverageReason && row.structuredLlmCoverageReason !== "structured-present") {
    return `Wrapped playback is present, but no structured LLM sidecar rows were recoverable: ${row.structuredLlmCoverageDetail}`;
  }
  if (row.nonModelArtifactExclusionReason) {
    return `Excluded from model-call artifact requirement: ${row.nonModelArtifactExclusionReason}`;
  }
  if (row.wrappedRunCount > 0) {
    if (row.latestWrappedRun?.exitCode === 0) {
      return "Wrapper artifact evidence exists; review the captured report, logs, trajectory JSONL, and HTML viewer.";
    }
    return "Wrapper artifact evidence exists but the latest captured run failed; review the viewer and fix or document the required inputs.";
  }
  if (row.knownArtifactPath) {
    return "Verify generated artifacts are linked into reports/live-test-inventory or the scenario catalog.";
  }
  if (row.routeToScenarioRunner) {
    return "Run through scenario-runner with --run-dir and --export-native.";
  }
  if (row.likelyLlm) {
    return "Wrap with trajectory/native export and a small HTML run viewer before release evidence.";
  }
  if (row.kind === "e2e") {
    return "Attach Playwright/test output, screenshots, traces, and an HTML summary under reports/.";
  }
  return "Document exclusion or add an artifact writer if this exercises live model behavior.";
}

function structuredCoverage(row) {
  if (!row.modelArtifactRequired && !row.likelyLlm) {
    return { reason: "", detail: "" };
  }
  const structuredRuns = (row.wrappedRuns || []).filter(
    (run) => Number(run.structuredLlmCallCount || 0) > 0,
  );
  if (structuredRuns.length > 0) {
    return {
      reason: "structured-present",
      detail: `${structuredRuns.length} wrapped run(s) emitted structured LLM sidecar rows.`,
    };
  }
  if (!row.wrappedRunCount) {
    return {
      reason: "no-wrapped-playback",
      detail: "No wrapped playback run exists for this model-classified script.",
    };
  }
  const latest = row.latestWrappedRun || {};
  const value = `${row.packageJson} ${row.packageName} ${row.script} ${row.command} ${latest.label || ""}`;
  if (Number(latest.exitCode) === 124) {
    return {
      reason: "timeout-before-sidecar",
      detail: "The captured wrapper run timed out before any sidecar LLM call rows were emitted.",
    };
  }
  if (/self-test|validate-capability-router|audit-capability-router|remote-capabilities/i.test(value)) {
    return {
      reason: "validation-or-self-test-no-model-call",
      detail: "The wrapped run exercises capability validation or self-test logic and did not emit provider prompt/response sidecars.",
    };
  }
  if (/mobile-local-chat|android|ios|simulator|voice-live-validation|voice:validate/i.test(value)) {
    return {
      reason: "external-runtime-no-sidecar",
      detail: "The wrapped run is gated on mobile, simulator, voice, or device runtime behavior and produced runtime logs rather than LLM sidecar rows.",
    };
  }
  const latestOutput = `${latest.stdoutExcerpt || ""} ${latest.stderrExcerpt || ""}`;
  if (/SKIP .*server is unavailable|server is unavailable|fetch failed|ECONNREFUSED|connection refused/i.test(latestOutput)) {
    return {
      reason: "runtime-service-unavailable-no-sidecar",
      detail: "The wrapped run completed as a runtime skip because a required local service was unavailable before any model-call sidecar rows could be emitted.",
    };
  }
  if (Number(latest.exitCode) !== 0) {
    return {
      reason: "wrapper-failed-before-sidecar",
      detail: "The latest wrapped run failed before a structured LLM sidecar could be emitted.",
    };
  }
  return {
    reason: "no-call-artifact-emitted",
    detail: "The wrapped run completed but did not emit llm-calls.jsonl or recoverable scenario trajectory model stages.",
  };
}

function inventoryScripts(wrappedRuns = []) {
  const rows = [];
  for (const file of packageJsonPaths()) {
    const pkg = readPackage(file);
    if (!pkg || typeof pkg !== "object") continue;
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    for (const [name, command] of Object.entries(scripts)) {
      const value = `${name} ${command}`;
      if (!SCRIPT_PATTERN.test(value)) continue;
      const knownArtifactPath = KNOWN_ARTIFACT_SCRIPT_PATTERNS.some((pattern) =>
        pattern.test(value),
      );
      const baseRow = {
        packageJson: file,
        packageName: typeof pkg.name === "string" ? pkg.name : "",
        script: name,
        command: String(command),
        kind: scriptKind(name, String(command)),
        likelyLlm: isLikelyLlmScript(name, String(command)),
        knownArtifactPath,
        routeToScenarioRunner: /scenario/i.test(value),
        routeToRecordingViewer: /e2e:record|generate-viewer/i.test(value),
      };
      const evidenceRuns = matchingWrappedRuns(baseRow, wrappedRuns).map(
        (run) => ({
          label: run.label,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          durationMs: run.durationMs,
          exitCode: run.exitCode,
          viewerIndex: run.viewerIndex,
          playbackIndex: run.playbackIndex,
          llmCallsJsonl: run.llmCallsJsonl,
          structuredLlmCallCount: run.structuredLlmCallCount,
          structuredTotalTokens: run.structuredTotalTokens,
          structuredCacheReadInputTokens: run.structuredCacheReadInputTokens,
          stdoutExcerpt: run.stdoutExcerpt,
          stderrExcerpt: run.stderrExcerpt,
          reportJson: run.reportJson,
        }),
      );
      const hasArtifactEvidence = knownArtifactPath || evidenceRuns.length > 0;
      const enrichedRow = {
        ...baseRow,
        wrappedRunCount: evidenceRuns.length,
        hasArtifactEvidence,
        latestWrappedRun: evidenceRuns.at(-1) || null,
        wrappedRuns: evidenceRuns,
      };
      const exclusionReason = nonModelExclusion(enrichedRow);
      rows.push({
        ...enrichedRow,
        modelArtifactRequired: enrichedRow.likelyLlm,
        nonModelArtifactExcluded: Boolean(exclusionReason),
        nonModelArtifactExclusionReason: exclusionReason,
        artifactScope: enrichedRow.likelyLlm
          ? "model-call"
          : enrichedRow.hasArtifactEvidence
            ? "non-model-artifact-evidence"
            : exclusionReason
              ? "non-model-excluded"
              : "non-model-unclassified",
      });
    }
  }
  return rows;
}

function withSuggestedActions(rows) {
  return rows.map((row) => {
    const coverage = structuredCoverage(row);
    const enriched = {
      ...row,
      structuredLlmCoverageReason: coverage.reason,
      structuredLlmCoverageDetail: coverage.detail,
    };
    return {
      ...enriched,
      suggestedAction: suggestedAction(enriched),
    };
  });
}

function relativizeArtifactLinks(rows, reportDir) {
  return rows.map((row) => {
    const wrappedRuns = (row.wrappedRuns || []).map((run) => ({
      ...run,
      viewerIndex: relFromReport(run.viewerIndex, reportDir),
      playbackIndex: relFromReport(run.playbackIndex, reportDir),
      llmCallsJsonl: relFromReport(run.llmCallsJsonl, reportDir),
      reportJson: relFromReport(run.reportJson, reportDir),
    }));
    return {
      ...row,
      latestWrappedRun: row.latestWrappedRun
        ? {
            ...row.latestWrappedRun,
            viewerIndex: relFromReport(row.latestWrappedRun.viewerIndex, reportDir),
            playbackIndex: relFromReport(row.latestWrappedRun.playbackIndex, reportDir),
            llmCallsJsonl: relFromReport(row.latestWrappedRun.llmCallsJsonl, reportDir),
            reportJson: relFromReport(row.latestWrappedRun.reportJson, reportDir),
          }
        : null,
      wrappedRuns,
    };
  });
}

function scriptFindings(rows) {
  return rows.map((row) => {
    let disposition = "needs-evidence";
    const reasons = [];
    if (row.modelArtifactRequired) {
      if (!row.hasArtifactEvidence) {
        disposition = "model-artifact-gap";
        reasons.push("likely model-call script without artifact evidence");
      } else if (row.wrappedRunCount > 0 && row.latestWrappedRun?.exitCode === 0) {
        disposition = "model-wrapper-pass";
        reasons.push("latest wrapped artifact run passed");
      } else if (row.wrappedRunCount > 0 && row.latestWrappedRun?.exitCode !== 0) {
        disposition = "model-wrapper-failed";
        reasons.push("latest wrapped artifact run failed");
      } else if (row.knownArtifactPath) {
        disposition = "model-artifact-hint";
        reasons.push("script has built-in artifact/report path hint");
      } else {
        disposition = "model-artifact-evidence";
        reasons.push("model-call artifact evidence exists");
      }
    } else if (row.nonModelArtifactExcluded) {
      disposition = "non-model-excluded";
      reasons.push(row.nonModelArtifactExclusionReason || "documented non-model exclusion");
    } else if (row.hasArtifactEvidence) {
      disposition = row.wrappedRunCount > 0 && row.latestWrappedRun?.exitCode !== 0
        ? "non-model-wrapper-failed"
        : "non-model-artifact-evidence";
      reasons.push(
        row.wrappedRunCount > 0
          ? "wrapper artifact evidence exists"
          : "built-in artifact/report path hint exists",
      );
    } else {
      disposition = "non-model-unclassified";
      reasons.push("no model requirement, artifact evidence, or explicit exclusion");
    }
    if (row.knownArtifactPath) reasons.push("artifact hint present");
    if (row.wrappedRunCount > 0) {
      reasons.push(`${row.wrappedRunCount} wrapped run(s) captured`);
    }
    const structuredLlmRunCount = (row.wrappedRuns || []).filter(
      (run) => Number(run.structuredLlmCallCount || 0) > 0,
    ).length;
    const structuredLlmCallCount = (row.wrappedRuns || []).reduce(
      (sum, run) => sum + Number(run.structuredLlmCallCount || 0),
      0,
    );
    if (structuredLlmCallCount > 0) {
      reasons.push(`${structuredLlmCallCount} structured LLM call(s) captured`);
    } else if (row.modelArtifactRequired && row.structuredLlmCoverageReason) {
      reasons.push(`structured LLM sidecar status: ${row.structuredLlmCoverageReason}`);
    }
    return {
      packageJson: row.packageJson,
      packageName: row.packageName,
      script: row.script,
      kind: row.kind,
      likelyLlm: row.likelyLlm,
      artifactScope: row.artifactScope,
      disposition,
      hasArtifactEvidence: row.hasArtifactEvidence,
      knownArtifactPath: row.knownArtifactPath,
      wrappedRunCount: row.wrappedRunCount,
      structuredLlmRunCount,
      structuredLlmCallCount,
      latestStructuredLlmCallCount:
        row.latestWrappedRun?.structuredLlmCallCount ?? 0,
      latestLlmCallsJsonl: row.latestWrappedRun?.llmCallsJsonl || "",
      latestWrappedExitCode: row.latestWrappedRun?.exitCode ?? null,
      latestWrappedViewer: row.latestWrappedRun?.viewerIndex || "",
      latestWrappedPlayback: row.latestWrappedRun?.playbackIndex || "",
      modelReviewHref: row.modelReviewHref || "",
      structuredLlmCoverageReason: row.structuredLlmCoverageReason || "",
      structuredLlmCoverageDetail: row.structuredLlmCoverageDetail || "",
      reasons,
    };
  });
}

function findingSummary(findings) {
  const byDisposition = {};
  for (const finding of findings) {
    byDisposition[finding.disposition] =
      (byDisposition[finding.disposition] || 0) + 1;
  }
  return {
    findingCount: findings.length,
    byDisposition,
    modelWrapperPass: byDisposition["model-wrapper-pass"] || 0,
    modelWrapperFailed: byDisposition["model-wrapper-failed"] || 0,
    modelArtifactHint: byDisposition["model-artifact-hint"] || 0,
    modelArtifactGap: byDisposition["model-artifact-gap"] || 0,
    nonModelExcluded: byDisposition["non-model-excluded"] || 0,
    nonModelArtifactEvidence:
      (byDisposition["non-model-artifact-evidence"] || 0) +
      (byDisposition["non-model-wrapper-failed"] || 0),
    nonModelUnclassified: byDisposition["non-model-unclassified"] || 0,
  };
}

function groupRows(rows) {
  const byPackage = {};
  for (const row of rows) {
    const key = row.packageName || row.packageJson;
    byPackage[key] ??= [];
    byPackage[key].push(row);
  }
  return byPackage;
}

function modelScriptReviewHtml(row, finding) {
  const wrappedRuns = row.wrappedRuns || [];
  const evidenceRows = [
    ["Disposition", finding.disposition],
    ["Artifact scope", row.artifactScope],
    ["Likely LLM", row.likelyLlm ? "yes" : "no"],
    ["Has artifact evidence", row.hasArtifactEvidence ? "yes" : "no"],
    ["Built-in artifact hint", row.knownArtifactPath ? "yes" : "no"],
    ["Wrapped run count", row.wrappedRunCount || 0],
    ["Latest wrapped exit", row.latestWrappedRun?.exitCode ?? "n/a"],
    ["Structured LLM runs", (row.wrappedRuns || []).filter((run) => Number(run.structuredLlmCallCount || 0) > 0).length],
    ["Structured LLM calls", (row.wrappedRuns || []).reduce((sum, run) => sum + Number(run.structuredLlmCallCount || 0), 0)],
    ["Structured coverage reason", row.structuredLlmCoverageReason || "n/a"],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(row.packageJson)} ${escapeHtml(row.script)}</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#172017; --muted:#5e675d; --line:#d7ded1; --ok:#17633a; --bad:#a12222; --accent:#116b5b; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid var(--line); padding:18px 22px; }
    h1 { margin:0 0 6px; font-size:20px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid var(--line); font-size:15px; }
    main { display:grid; grid-template-columns:1fr 1fr; gap:14px; padding:16px 22px 22px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    .body { padding:12px; }
    .muted { color:var(--muted); }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { white-space:pre-wrap; overflow:auto; background:#f8faf5; border:1px solid var(--line); border-radius:6px; padding:8px; }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:7px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    .ok { color:var(--ok); font-weight:700; }
    .bad { color:var(--bad); font-weight:700; }
    @media (max-width:900px) { main { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1><code>${escapeHtml(row.script)}</code></h1>
    <div class="muted"><code>${escapeHtml(row.packageJson)}</code> · ${escapeHtml(row.packageName || "")}</div>
  </header>
  <main>
    <section class="panel"><h2>Review Summary</h2><div class="body">
      <table><tbody>${evidenceRows
        .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
        .join("")}</tbody></table>
      <p><strong>Reasons:</strong> ${escapeHtml((finding.reasons || []).join("; "))}</p>
      ${
        row.structuredLlmCoverageDetail
          ? `<p><strong>Structured sidecar detail:</strong> ${escapeHtml(row.structuredLlmCoverageDetail)}</p>`
          : ""
      }
      <p><strong>Next action:</strong> ${escapeHtml(row.suggestedAction)}</p>
    </div></section>
    <section class="panel"><h2>Command</h2><div class="body"><pre>${escapeHtml(row.command)}</pre></div></section>
    <section class="panel"><h2>Captured Runs</h2><div class="body">
      ${
        wrappedRuns.length
          ? `<table><thead><tr><th>started</th><th>exit</th><th>structured calls</th><th>playback</th><th>viewer</th><th>sidecar</th></tr></thead><tbody>${wrappedRuns
              .map(
                (run) =>
                  `<tr><td>${escapeHtml(run.startedAt)}</td><td class="${run.exitCode === 0 ? "ok" : "bad"}">${escapeHtml(run.exitCode)}</td><td>${escapeHtml(run.structuredLlmCallCount || 0)}</td><td>${run.playbackIndex ? `<a href="../${escapeHtml(run.playbackIndex)}">playback</a>` : ""}</td><td>${run.viewerIndex ? `<a href="../${escapeHtml(run.viewerIndex)}">viewer</a>` : ""}</td><td>${run.llmCallsJsonl ? `<a href="../${escapeHtml(run.llmCallsJsonl)}">llm-calls</a>` : ""}</td></tr>`,
              )
              .join("")}</tbody></table>`
          : '<p class="muted">No wrapped playback run exists for this script yet. This page records the built-in artifact route and keeps it directly reviewable from the queue.</p>'
      }
    </div></section>
    <section class="panel"><h2>Artifact Route</h2><div class="body">
      <p>${escapeHtml(
        row.knownArtifactPath
          ? "The script command/name matches a built-in artifact or report-producing route."
          : "No built-in artifact route was detected.",
      )}</p>
      <p><a href="../index.html">Back to live/e2e inventory</a></p>
    </div></section>
  </main>
</body>
</html>`;
}

function addModelScriptReviewLinks(rows, reportDir) {
  return rows.map((row) => {
    if (!row.modelArtifactRequired && !row.likelyLlm) return row;
    const fileName = `${slugify(`${row.packageJson}-${row.script}`)}.html`;
    return {
      ...row,
      modelReviewHref: `model-scripts/${fileName}`,
      modelReviewPath: path.join(reportDir, "model-scripts", fileName),
    };
  });
}

function writeModelScriptReviewPages(rows, findings, reportDir) {
  const dir = path.join(reportDir, "model-scripts");
  mkdirSync(dir, { recursive: true });
  const findingByScript = new Map(
    findings.map((finding) => [`${finding.packageJson}:${finding.script}`, finding]),
  );
  let count = 0;
  for (const row of rows) {
    if (!row.modelReviewPath) continue;
    const finding = findingByScript.get(`${row.packageJson}:${row.script}`) || {};
    writeFileSync(row.modelReviewPath, modelScriptReviewHtml(row, finding), "utf8");
    count += 1;
  }
  return count;
}

function inventoryHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Test Artifact Inventory</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#172017; --muted:#5e675d; --line:#d7ded1; --ok:#17633a; --bad:#a12222; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; z-index:3; background:#fff; border-bottom:1px solid var(--line); padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .muted { color:var(--muted); }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; padding:14px 20px; }
    .card,.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    main { padding:0 20px 20px; }
    .panel { overflow:hidden; }
    .controls { display:grid; grid-template-columns:2fr repeat(5, minmax(130px, 1fr)); gap:8px; padding:10px; border-bottom:1px solid var(--line); }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:7px 8px; background:#fff; color:var(--ink); }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:7px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { position:sticky; top:65px; background:#f7faf4; z-index:2; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .ok { color:var(--ok); font-weight:600; }
    .bad { color:var(--bad); font-weight:600; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 6px; margin:0 3px 3px 0; font-size:11px; color:var(--muted); }
    @media (max-width:900px) { .controls { grid-template-columns:1fr; } th { top:0; } }
  </style>
</head>
<body>
  <header><h1>Live / Real / E2E Test Artifact Inventory</h1><div id="meta" class="muted"></div></header>
  <div id="cards" class="cards"></div>
  <main class="panel">
    <div class="controls">
      <input id="search" type="search" placeholder="Search package, script, command..." />
      <select id="artifact"><option value="">all artifact states</option><option value="evidence">has any evidence</option><option value="hint">has built-in hint</option><option value="wrapped">has wrapper evidence</option><option value="no">missing evidence</option><option value="excluded">non-model excluded</option><option value="unclassified">non-model unclassified</option></select>
      <select id="llm"><option value="">all LLM states</option><option value="yes">likely LLM</option><option value="no">not likely LLM</option></select>
      <select id="disposition"><option value="">all dispositions</option></select>
      <select id="kind"><option value="">all kinds</option></select>
      <select id="package"><option value="">all packages</option></select>
    </div>
    <div id="table"></div>
  </main>
  <script src="./inventory-data.js"></script>
  <script>
    const data = window.LIVE_TEST_INVENTORY || { rows: [], summary: {} };
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function renderCards() {
      const s = data.summary || {};
      const f = data.findingSummary || {};
      const items = [["Scripts", s.totalScripts || 0], ["Packages", s.packageCount || 0], ["Artifact hints", s.knownArtifactScripts || 0], ["Wrapper evidence", s.wrapperEvidenceScripts || 0], ["Wrapper playback", s.wrapperPlaybackRuns || 0], ["Structured sidecars", s.structuredLlmRuns || 0], ["Structured calls", s.structuredLlmCallCount || 0], ["Structured model scripts", s.structuredLlmModelScripts || 0], ["Structured reasons", s.structuredLlmModelScriptsWithReason || 0], ["Model review pages", s.modelScriptReviewPages || 0], ["Evidence present", s.artifactEvidenceScripts || 0], ["Likely LLM gaps", s.likelyLlmScriptsWithoutArtifactEvidence || 0], ["Model wrapper pass", f.modelWrapperPass || 0], ["Model wrapper failed", f.modelWrapperFailed || 0], ["Model artifact hints", f.modelArtifactHint || 0], ["Non-model excluded", s.nonModelArtifactExcludedScripts || 0], ["Non-model unclassified", s.nonModelUnclassifiedWithoutArtifactEvidence || 0]];
      document.getElementById("cards").innerHTML = items.map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join("");
      document.getElementById("meta").textContent = (data.generatedAt || "") + " · " + (data.reportDir || "");
    }
    function renderFilters() {
      const kinds = [...new Set((data.rows || []).map(r => r.kind).filter(Boolean))].sort();
      const packages = [...new Set((data.rows || []).map(r => r.packageJson).filter(Boolean))].sort();
      const dispositions = [...new Set((data.scriptFindings || []).map(r => r.disposition).filter(Boolean))].sort();
      document.getElementById("kind").innerHTML = '<option value="">all kinds</option>' + kinds.map(k => '<option>' + esc(k) + '</option>').join("");
      document.getElementById("package").innerHTML = '<option value="">all packages</option>' + packages.map(p => '<option>' + esc(p) + '</option>').join("");
      document.getElementById("disposition").innerHTML = '<option value="">all dispositions</option>' + dispositions.map(d => '<option>' + esc(d) + '</option>').join("");
    }
    function filtered() {
      const q = document.getElementById("search").value.toLowerCase();
      const artifact = document.getElementById("artifact").value;
      const llm = document.getElementById("llm").value;
      const disposition = document.getElementById("disposition").value;
      const kind = document.getElementById("kind").value;
      const pkg = document.getElementById("package").value;
      return (data.rows || []).filter(r => {
        const finding = (data.scriptFindings || []).find(f => f.packageJson === r.packageJson && f.script === r.script) || {};
        const hay = [r.packageJson, r.packageName, r.script, r.command, r.suggestedAction, r.nonModelArtifactExclusionReason, r.artifactScope, r.structuredLlmCoverageReason, r.structuredLlmCoverageDetail, finding.disposition, (finding.reasons || []).join(" ")].join(" ").toLowerCase();
        const artifactState = artifact === "evidence" ? r.hasArtifactEvidence : artifact === "hint" ? r.knownArtifactPath : artifact === "wrapped" ? r.wrappedRunCount > 0 : artifact === "no" ? !r.hasArtifactEvidence : artifact === "excluded" ? r.nonModelArtifactExcluded : artifact === "unclassified" ? r.artifactScope === "non-model-unclassified" : true;
        return (!q || hay.includes(q)) && artifactState && (!llm || (r.likelyLlm ? "yes" : "no") === llm) && (!disposition || finding.disposition === disposition) && (!kind || r.kind === kind) && (!pkg || r.packageJson === pkg);
      });
    }
    function renderTable() {
      const rows = filtered();
      document.getElementById("table").innerHTML = '<table><thead><tr><th>package</th><th>script</th><th>classification</th><th>finding</th><th>captured runs</th><th>command</th><th>next action</th></tr></thead><tbody>' + rows.map(r => { const finding = (data.scriptFindings || []).find(f => f.packageJson === r.packageJson && f.script === r.script) || {}; return '<tr><td><code>' + esc(r.packageJson) + '</code><br><span class="muted">' + esc(r.packageName) + '</span></td><td><code>' + esc(r.script) + '</code>' + (r.modelReviewHref ? '<br><a href="' + esc(r.modelReviewHref) + '">model review</a>' : '') + '</td><td><span class="pill">' + esc(r.kind) + '</span><span class="pill ' + (r.likelyLlm ? 'bad' : '') + '">' + (r.likelyLlm ? 'likely LLM' : 'not LLM') + '</span><span class="pill ' + (r.nonModelArtifactExcluded ? 'ok' : '') + '">' + esc(r.artifactScope || '') + '</span><span class="pill ' + (r.knownArtifactPath ? 'ok' : '') + '">' + (r.knownArtifactPath ? 'artifact hint' : 'no artifact hint') + '</span><span class="pill ' + (r.wrappedRunCount > 0 ? 'ok' : '') + '">' + esc(r.wrappedRunCount || 0) + ' wrapped</span><span class="pill">' + esc(r.structuredLlmCoverageReason || 'no structured status') + '</span></td><td><strong class="' + (String(finding.disposition || '').includes('gap') || String(finding.disposition || '').includes('failed') ? 'bad' : 'ok') + '">' + esc(finding.disposition || '') + '</strong><br><span class="muted">' + esc((finding.reasons || []).join('; ')) + '</span></td><td>' + (r.latestWrappedRun ? '<a href="' + esc(r.latestWrappedRun.playbackIndex || r.latestWrappedRun.viewerIndex) + '">playback</a> · <a href="' + esc(r.latestWrappedRun.viewerIndex) + '">viewer</a><br><span class="' + (r.latestWrappedRun.exitCode === 0 ? 'ok' : 'bad') + '">exit ' + esc(r.latestWrappedRun.exitCode) + '</span> <span class="muted">' + esc(r.latestWrappedRun.startedAt) + '</span>' : '<span class="muted">none</span>') + '</td><td><code>' + esc(r.command) + '</code></td><td>' + esc(r.suggestedAction) + '</td></tr>'; }).join("") + '</tbody></table>';
    }
    for (const id of ["search","artifact","llm","disposition","kind","package"]) document.addEventListener("input", e => { if (e.target.id === id) renderTable(); });
    document.addEventListener("change", e => { if (["artifact","llm","disposition","kind","package"].includes(e.target.id)) renderTable(); });
    renderCards(); renderFilters(); renderTable();
  </script>
</body>
</html>`;
}

function renderMarkdown(payload) {
  const lines = [
    "# Live / Real / E2E Test Artifact Inventory",
    "",
    `Generated: ${payload.generatedAt}`,
    `Scripts matching live/real/e2e: ${payload.summary.totalScripts}`,
    `Scripts with known artifact path hints: ${payload.summary.knownArtifactScripts}`,
    `Scripts without known artifact path hints: ${payload.summary.unknownArtifactScripts}`,
    `Scripts with wrapper evidence: ${payload.summary.wrapperEvidenceScripts}`,
    `Wrapped runs with playback pages: ${payload.summary.wrapperPlaybackRuns}`,
    `Wrapped runs with structured LLM sidecar calls: ${payload.summary.structuredLlmRuns}`,
    `Structured LLM sidecar calls: ${payload.summary.structuredLlmCallCount}`,
    `Model scripts with structured LLM sidecar calls: ${payload.summary.structuredLlmModelScripts}`,
    `Model scripts with structured LLM sidecar status or reason: ${payload.summary.structuredLlmModelScriptsWithReason}`,
    `Likely model-call script review pages: ${payload.summary.modelScriptReviewPages}`,
    `Scripts with any artifact evidence: ${payload.summary.artifactEvidenceScripts}`,
    `Non-model scripts excluded from model-call artifact requirement: ${payload.summary.nonModelArtifactExcludedScripts}`,
    `Non-model scripts still unclassified without artifact evidence: ${payload.summary.nonModelUnclassifiedWithoutArtifactEvidence}`,
    `Likely LLM scripts: ${payload.summary.likelyLlmScripts}`,
    `Likely LLM scripts without artifact hints: ${payload.summary.likelyLlmScriptsWithoutArtifacts}`,
    `Likely LLM scripts without any artifact evidence: ${payload.summary.likelyLlmScriptsWithoutArtifactEvidence}`,
    `Script review findings: ${payload.findingSummary.findingCount}`,
    `Model wrapper pass findings: ${payload.findingSummary.modelWrapperPass}`,
    `Model wrapper failed findings: ${payload.findingSummary.modelWrapperFailed}`,
    `Model artifact hint findings: ${payload.findingSummary.modelArtifactHint}`,
    `Model artifact gap findings: ${payload.findingSummary.modelArtifactGap}`,
    `Non-model excluded findings: ${payload.findingSummary.nonModelExcluded}`,
    `Non-model unclassified findings: ${payload.findingSummary.nonModelUnclassified}`,
    "",
    `HTML viewer: ${payload.viewerIndex}`,
    "",
    "Known artifact path hints are conservative name/command matches for scenario-runner, e2e recordings/viewers, or remote-capability report/artifact validators. Wrapper evidence comes from `reports/live-test-runs/*/report.json`. Non-model exclusions are explicit taxonomy matches for UI, device, database, migration, package-aggregator, template, lint, or plugin-smoke scripts that do not exercise LLM token/cache behavior. A row without evidence and without an exclusion remains an inventory follow-up.",
    "",
  ];
  lines.push(
    "## Script Review Findings",
    "",
    "| package | script | disposition | evidence | reasons |",
    "|---|---|---|---|---|",
  );
  for (const finding of payload.scriptFindings) {
    lines.push(
      `| \`${finding.packageJson}\` | \`${finding.script}\` | ${finding.disposition} | likely LLM=${finding.likelyLlm ? "yes" : "no"}; artifact=${finding.hasArtifactEvidence ? "yes" : "no"}; wrapped=${finding.wrappedRunCount}; exit=${finding.latestWrappedExitCode ?? ""}; structured=${finding.structuredLlmCoverageReason || ""}; review=${finding.modelReviewHref || ""} | ${(finding.reasons || []).join("; ").replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("", "## Scripts", "", "| package | script | kind | artifact scope | likely LLM | artifact hint | wrapped runs | latest wrapped exit | next action | command |", "|---|---|---:|---|---:|---:|---:|---:|---|---|");
  for (const row of payload.rows) {
    lines.push(
      `| \`${row.packageJson}\` | \`${row.script}\` | ${row.kind} | ${row.artifactScope} | ${row.likelyLlm ? "yes" : "no"} | ${row.knownArtifactPath ? "yes" : "no"} | ${row.wrappedRunCount || 0} | ${row.latestWrappedRun ? row.latestWrappedRun.exitCode : ""} | ${row.suggestedAction.replaceAll("|", "\\|")} | \`${row.command.replaceAll("|", "\\|")}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.reportDir, { recursive: true });
  const wrappedRuns = readWrappedRuns();
  const rowsWithReviewPaths = addModelScriptReviewLinks(
    relativizeArtifactLinks(
      withSuggestedActions(inventoryScripts(wrappedRuns)),
      options.reportDir,
    ),
    options.reportDir,
  );
  const rows = rowsWithReviewPaths.map(({ modelReviewPath, ...row }) => row);
  const findings = scriptFindings(rows);
  const modelScriptReviewPages = writeModelScriptReviewPages(
    rowsWithReviewPaths,
    findings,
    options.reportDir,
  );
  const viewerIndexPath = path.join(options.reportDir, "index.html");
  const viewerDataPath = path.join(options.reportDir, "inventory-data.js");
  const payload = {
    schema: "eliza_live_test_artifact_inventory_v1",
    generatedAt: new Date().toISOString(),
    reportDir: options.reportDir,
    summary: {
      totalScripts: rows.length,
      knownArtifactScripts: rows.filter((row) => row.knownArtifactPath).length,
      unknownArtifactScripts: rows.filter((row) => !row.knownArtifactPath).length,
      wrapperEvidenceScripts: rows.filter((row) => row.wrappedRunCount > 0).length,
      artifactEvidenceScripts: rows.filter((row) => row.hasArtifactEvidence)
        .length,
      scriptsWithoutArtifactEvidence: rows.filter((row) => !row.hasArtifactEvidence)
        .length,
      nonModelArtifactExcludedScripts: rows.filter(
        (row) => row.nonModelArtifactExcluded,
      ).length,
      nonModelUnclassifiedWithoutArtifactEvidence: rows.filter(
        (row) =>
          !row.likelyLlm &&
          !row.hasArtifactEvidence &&
          !row.nonModelArtifactExcluded,
      ).length,
      modelArtifactRequiredScripts: rows.filter((row) => row.modelArtifactRequired)
        .length,
      modelArtifactRequiredWithoutEvidence: rows.filter(
        (row) => row.modelArtifactRequired && !row.hasArtifactEvidence,
      ).length,
      likelyLlmScripts: rows.filter((row) => row.likelyLlm).length,
      likelyLlmScriptsWithoutArtifacts: rows.filter(
        (row) => row.likelyLlm && !row.knownArtifactPath,
      ).length,
      likelyLlmScriptsWithoutArtifactEvidence: rows.filter(
        (row) => row.likelyLlm && !row.hasArtifactEvidence,
      ).length,
      packageCount: new Set(rows.map((row) => row.packageJson)).size,
      wrappedRuns: wrappedRuns.length,
      wrapperPlaybackRuns: wrappedRuns.filter((run) => run.playbackIndex).length,
      structuredLlmRuns: wrappedRuns.filter(
        (run) => Number(run.structuredLlmCallCount || 0) > 0,
      ).length,
      structuredLlmCallCount: wrappedRuns.reduce(
        (sum, run) => sum + Number(run.structuredLlmCallCount || 0),
        0,
      ),
      structuredLlmModelScripts: rows.filter(
        (row) =>
          row.modelArtifactRequired &&
          (row.wrappedRuns || []).some(
            (run) => Number(run.structuredLlmCallCount || 0) > 0,
          ),
      ).length,
      structuredLlmModelScriptsWithReason: rows.filter(
        (row) => row.modelArtifactRequired && row.structuredLlmCoverageReason,
      ).length,
      modelScriptReviewPages,
      passedWrappedRuns: wrappedRuns.filter((run) => run.exitCode === 0).length,
      failedWrappedRuns: wrappedRuns.filter((run) => run.exitCode !== 0).length,
    },
    viewerIndex: "index.html",
    viewerData: "inventory-data.js",
    scriptFindings: findings,
    findingSummary: findingSummary(findings),
    byPackage: groupRows(rows),
    rows,
  };
  writeFileSync(
    path.join(options.reportDir, "inventory.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(options.reportDir, "README.md"),
    renderMarkdown(payload),
    "utf8",
  );
  writeFileSync(viewerIndexPath, inventoryHtml(), "utf8");
  writeFileSync(
    viewerDataPath,
    `window.LIVE_TEST_INVENTORY = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  if (options.json) {
    process.stdout.write(JSON.stringify(payload.summary, null, 2) + "\n");
  } else {
    process.stdout.write(
      `live/e2e script inventory ${payload.summary.totalScripts} scripts; ${payload.summary.scriptsWithoutArtifactEvidence} without artifact evidence\n`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
