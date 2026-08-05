#!/usr/bin/env node
/**
 * Classifies changed repository paths into CI test lanes. Pull requests use a
 * merge-base inventory while branch-health events deliberately run all lanes.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const CONFIGS = {
  test: {
    title: "Tests path gate",
    outputs: ["server", "client", "plugins", "desktop", "zero_key", "cloud"],
    labels: {
      "ci:full": [
        "server",
        "client",
        "plugins",
        "desktop",
        "zero_key",
        "cloud",
      ],
      "ci:server": ["server"],
      "ci:client": ["client"],
      "ci:plugins": ["plugins"],
      "ci:desktop": ["desktop"],
      "ci:e2e": ["zero_key"],
      "ci:zero-key": ["zero_key"],
      "ci:cloud": ["cloud"],
    },
    rules: [
      {
        lanes: ["server", "client", "plugins", "desktop", "zero_key", "cloud"],
        patterns: [
          "package.json",
          "bun.lock",
          "turbo.json",
          "tsconfig*.json",
          "vitest.config.*",
        ],
        reason: "workspace toolchain",
      },
      {
        lanes: ["server", "client", "plugins", "desktop", "zero_key", "cloud"],
        patterns: [
          ".github/workflows/ci.yml",
          ".github/actions/setup-bun-workspace/**",
          "packages/scripts/ci-path-gate.mjs",
        ],
        reason: "test workflow or shared CI setup",
      },
      {
        lanes: ["server", "client", "plugins", "desktop", "zero_key"],
        patterns: [
          "packages/core/**",
          "packages/agent/**",
          "packages/shared/**",
          "packages/prompts/**",
          "packages/test/**",
        ],
        reason: "shared runtime surface",
      },
      {
        lanes: ["client", "zero_key"],
        patterns: ["packages/app/**", "packages/ui/**"],
        reason: "app or shared UI",
      },
      {
        lanes: ["server", "client", "desktop", "zero_key"],
        patterns: ["packages/app-core/**"],
        reason: "app-core host or desktop bridge",
      },
      {
        lanes: ["server", "zero_key"],
        patterns: ["packages/scenario-runner/**", "packages/scripts/**"],
        reason: "scenario runner or repo scripts",
      },
      {
        lanes: ["server", "client", "zero_key", "cloud"],
        patterns: ["packages/cloud/sdk/**", "packages/cloud/shared/**"],
        reason: "cloud surface",
      },
      {
        lanes: ["server"],
        patterns: ["packages/core/src/security/**", "packages/vault/**"],
        reason: "core security or vault package",
      },
      {
        lanes: ["server"],
        patterns: ["packages/elizaos/**", "packages/skills/**"],
        reason:
          "elizaos CLI or runtime skills - test:server runs these suites (previously unmapped: a CLI/skills-only PR skipped every test lane)",
      },
      {
        lanes: ["plugins", "zero_key"],
        patterns: ["plugins/**"],
        reason: "plugin surface",
      },
    ],
    // Fail-safe: a PR that changes real code/test surface (packages/** or
    // plugins/**) but matches no rule above must NOT skip every lane and pass
    // green. Any such orphan path runs the `server` lane as a minimal safe net
    // (it builds core + runs the core/agent/shared suite). Pure docs/marketing
    // surfaces are exempted so they can still skip cleanly.
    failSafe: {
      lanes: ["server"],
      codeRoots: ["packages/**", "plugins/**"],
      ignore: [
        "packages/docs/**",
        "packages/homepage/**",
        "packages/cloud/docs-redirect/**",
      ],
      reason:
        "unmapped code path - no lane rule matched; running the server lane as a fail-safe so a code change can never skip every test lane",
    },
  },
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function globToRegExp(pattern) {
  const sentinel = "\0";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, sentinel)
    .replace(/\*/g, "[^/]*")
    .replaceAll(sentinel, "[\\s\\S]*");
  return new RegExp(`^${escaped}$`);
}

const patternCache = new Map();
function matches(pattern, path) {
  if (!patternCache.has(pattern)) {
    patternCache.set(pattern, globToRegExp(pattern));
  }
  return patternCache.get(pattern).test(path);
}

// Diffs from the merge-base of base..head, not from the base TIP. The base
// SHA the workflow passes is `pull_request.base.sha` — the base branch's tip,
// which advances as other PRs merge. A plain two-dot `git diff base head`
// would charge a PR that trails its base branch with every develop-side file
// it never touched, over-triggering heavy lanes (including the fail-safe
// lanes) for unrelated changes (#16125). The merge-base diff is exactly what
// the GitHub "Files changed" tab shows. Callers check out with fetch-depth: 0
// so the merge-base is resolvable; if it is not (bad fetch depth, unrelated
// histories), fail loud rather than silently diffing the entire tree.
export function gitChangedFiles(base, head, cwd) {
  const mergeBaseResult = spawnSync("git", ["merge-base", base, head], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const mergeBase = mergeBaseResult.stdout.trim();
  if (mergeBaseResult.status !== 0 || !mergeBase) {
    throw new Error(
      `no merge-base between ${base} and ${head} — insufficient fetch depth or unrelated histories` +
        (mergeBaseResult.stderr ? `: ${mergeBaseResult.stderr.trim()}` : ""),
    );
  }
  const result = spawnSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", mergeBase, head],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `git diff exited with ${result.status}`);
  }

  return parseGitNameStatus(result.stdout);
}

export function parseGitNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const paths = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (/^[RC]\d{1,3}$/.test(status)) {
      const source = fields[index++];
      const destination = fields[index++];
      if (source === undefined || destination === undefined) {
        throw new Error(`malformed git diff record for ${status}`);
      }
      // Both endpoints affect lane ownership when code crosses a package
      // boundary; classifying only the destination can hide removed coverage.
      paths.push(source, destination);
      continue;
    }
    if (!/^[ADMTUXB]$/.test(status)) {
      throw new Error(`unsupported git diff status '${status}'`);
    }
    const path = fields[index++];
    if (path === undefined) {
      throw new Error(`malformed git diff record for ${status}`);
    }
    paths.push(path);
  }
  return [...new Set(paths)];
}

function addLane(matchesByLane, lane, source) {
  if (!matchesByLane.has(lane)) {
    matchesByLane.set(lane, []);
  }
  matchesByLane.get(lane).push(source);
}

function anyMatch(patterns, path) {
  return patterns.some((pattern) => matches(pattern, path));
}

// Guarantees a PR that changes real code/test surface cannot skip every test
// lane and pass green. Any changed file under a `codeRoot` that matched no rule
// (and is not an explicitly-exempt docs/marketing path) enables the fail-safe
// lanes. Configs without a `failSafe` block are unaffected.
function applyFailSafe(config, changedFiles, matchedPaths, matchesByLane) {
  const failSafe = config.failSafe;
  if (!failSafe) {
    return;
  }
  for (const path of changedFiles) {
    if (matchedPaths.has(path)) {
      continue;
    }
    if (!anyMatch(failSafe.codeRoots, path)) {
      continue;
    }
    if (failSafe.ignore && anyMatch(failSafe.ignore, path)) {
      continue;
    }
    for (const lane of failSafe.lanes) {
      addLane(matchesByLane, lane, {
        kind: "failsafe",
        path,
        reason: failSafe.reason,
      });
    }
  }
}

function evaluate(config, { eventName, labels, base, head, changedFilesPath }) {
  const matchesByLane = new Map(config.outputs.map((output) => [output, []]));
  let changedFiles = [];

  // PRs are the only place where this script narrows coverage by changed path.
  // Push, scheduled, and manual runs stay broad because they protect branch
  // health and release confidence after multiple PRs have composed.
  if (eventName !== "pull_request") {
    for (const lane of config.outputs) {
      addLane(matchesByLane, lane, {
        kind: "event",
        reason: `${eventName} runs this lane by default`,
      });
    }
    return { changedFiles, matchesByLane };
  }

  changedFiles = changedFilesPath
    ? readFileSync(changedFilesPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : gitChangedFiles(base, head);
  const labelSet = new Set(
    labels
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
  );

  for (const label of labelSet) {
    for (const lane of config.labels[label] || []) {
      addLane(matchesByLane, lane, {
        kind: "label",
        label,
        reason: `forced by ${label}`,
      });
    }
  }

  const matchedPaths = new Set();
  for (const path of changedFiles) {
    for (const rule of config.rules) {
      const pattern = rule.patterns.find((candidate) =>
        matches(candidate, path),
      );
      if (!pattern) {
        continue;
      }
      matchedPaths.add(path);
      for (const lane of rule.lanes) {
        addLane(matchesByLane, lane, {
          kind: "path",
          path,
          pattern,
          reason: rule.reason,
        });
      }
    }
  }

  applyFailSafe(config, changedFiles, matchedPaths, matchesByLane);

  return { changedFiles, matchesByLane };
}

function markdown(config, { changedFiles, matchesByLane, labels, eventName }) {
  const lines = [
    `### ${config.title}`,
    "",
    `- Event: \`${eventName}\``,
    `- Force labels: \`${labels || "(none)"}\``,
    "",
    "| Lane | Run | Why |",
    "| --- | --- | --- |",
  ];

  for (const lane of config.outputs) {
    const sources = matchesByLane.get(lane) || [];
    const reasons = sources.length
      ? sources
          .slice(0, 6)
          .map((source) => {
            if (source.kind === "path") {
              return `\`${source.path}\` matched \`${source.pattern}\` (${source.reason})`;
            }
            if (source.kind === "failsafe") {
              return `\`${source.path}\` unmapped -> fail-safe (${source.reason})`;
            }
            if (source.kind === "label") {
              return source.reason;
            }
            return source.reason;
          })
          .join("<br>")
      : "No matching paths or force labels.";
    lines.push(`| \`${lane}\` | \`${sources.length > 0}\` | ${reasons} |`);
  }

  if (changedFiles.length > 0) {
    lines.push("", "<details><summary>Changed files</summary>", "");
    for (const path of changedFiles) {
      lines.push(`- \`${path}\``);
    }
    lines.push("", "</details>");
  }

  return `${lines.join("\n")}\n`;
}

function writeOutputs(path, config, matchesByLane) {
  const body = config.outputs
    .map((lane) => `${lane}=${(matchesByLane.get(lane) || []).length > 0}`)
    .join("\n");
  if (path) {
    appendFileSync(path, `${body}\n`);
  } else {
    console.log(body);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configName = args.config;
  const config = CONFIGS[configName];
  if (!config) {
    throw new Error(
      `unknown config '${configName}'. Expected one of: ${Object.keys(CONFIGS).join(", ")}`,
    );
  }

  const eventName =
    args.event || process.env.GITHUB_EVENT_NAME || "pull_request";
  const labels = args.labels || "";
  const base = args.base || "";
  const head = args.head || "";
  const changedFilesPath = args["changed-files"] || "";

  if (eventName === "pull_request" && !changedFilesPath && (!base || !head)) {
    throw new Error(
      "--base and --head are required for pull_request events unless --changed-files is provided",
    );
  }

  const result = evaluate(config, {
    eventName,
    labels,
    base,
    head,
    changedFilesPath,
  });
  writeOutputs(
    args.output || process.env.GITHUB_OUTPUT,
    config,
    result.matchesByLane,
  );

  const summary = markdown(config, { ...result, labels, eventName });
  if (args.summary || process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(args.summary || process.env.GITHUB_STEP_SUMMARY, summary);
  } else {
    console.log(summary);
  }
}

if (import.meta.main) {
  main();
}
