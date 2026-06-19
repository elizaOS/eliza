#!/usr/bin/env node
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
          ".github/workflows/test.yml",
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
        patterns: [
          "packages/cloud-sdk/**",
          "packages/cloud-shared/**",
          "packages/cloud-frontend/**",
        ],
        reason: "cloud surface",
      },
      {
        lanes: ["server"],
        patterns: ["packages/security/**", "packages/vault/**"],
        reason: "security or vault package",
      },
      {
        lanes: ["plugins", "zero_key"],
        patterns: ["plugins/**"],
        reason: "plugin surface",
      },
    ],
  },
  "scenario-pr": {
    title: "Scenario PR E2E path gate",
    outputs: ["run_scenario_pr"],
    labels: {
      "ci:full": ["run_scenario_pr"],
      "ci:e2e": ["run_scenario_pr"],
      "ci:scenario": ["run_scenario_pr"],
      "ci:zero-key": ["run_scenario_pr"],
    },
    rules: [
      {
        lanes: ["run_scenario_pr"],
        patterns: [
          "package.json",
          "bun.lock",
          "turbo.json",
          "tsconfig*.json",
          "vite.config.*",
          "vitest.config.*",
        ],
        reason: "workspace toolchain",
      },
      {
        lanes: ["run_scenario_pr"],
        patterns: [
          ".github/workflows/scenario-pr.yml",
          ".github/actions/setup-bun-workspace/**",
          "packages/scripts/ci-path-gate.mjs",
        ],
        reason: "scenario workflow or shared CI setup",
      },
      {
        lanes: ["run_scenario_pr"],
        patterns: [
          "packages/app/**",
          "packages/ui/**",
          "packages/app-core/**",
          "packages/scenario-runner/**",
          "packages/core/**",
          "packages/agent/**",
          "packages/shared/**",
          "packages/scripts/**",
          "packages/test/**",
          "packages/prompts/**",
        ],
        reason: "scenario runtime, UI, or support package",
      },
      {
        lanes: ["run_scenario_pr"],
        patterns: [
          "plugins/plugin-app-control/**",
          "plugins/plugin-computeruse/**",
          "plugins/plugin-github/**",
        ],
        reason: "scenario-critical plugin",
      },
      {
        lanes: ["run_scenario_pr"],
        patterns: [
          "plugins/plugin-*/src/**",
          "plugins/plugin-*/package.json",
          "plugins/plugin-*/vite.config.*",
          "plugins/plugin-*/vitest.config.*",
        ],
        reason: "plugin implementation surface",
      },
    ],
  },
  docker: {
    title: "Docker smoke path gate",
    outputs: ["docker"],
    labels: {
      "ci:full": ["docker"],
      "ci:docker": ["docker"],
    },
    rules: [
      {
        lanes: ["docker"],
        patterns: [
          ".github/workflows/docker-ci-smoke.yml",
          ".github/actions/setup-bun-workspace/**",
          "packages/scripts/ci-path-gate.mjs",
          "package.json",
          "bun.lock",
          "bunfig.toml",
          "turbo.json",
          "packages/app-core/deploy/**",
          "packages/app-core/scripts/docker-ci-smoke.sh",
          "packages/app-core/scripts/docker-healthcheck.mjs",
        ],
        reason: "Docker smoke workflow or image contract",
      },
      {
        lanes: ["docker"],
        patterns: [
          "packages/app-core/**",
          "packages/agent/**",
          "packages/core/**",
          "packages/shared/**",
          "packages/prompts/**",
          "plugins/**",
        ],
        reason: "runtime included in production image",
      },
    ],
  },
  mobile: {
    title: "Mobile smoke path gate",
    outputs: ["ios", "android"],
    labels: {
      "ci:full": ["ios", "android"],
      "ci:mobile": ["ios", "android"],
      "ci:ios": ["ios"],
      "ci:android": ["android"],
    },
    rules: [
      {
        lanes: ["ios", "android"],
        patterns: [
          ".github/workflows/mobile-build-smoke.yml",
          ".github/actions/setup-bun-workspace/**",
          "packages/scripts/ci-path-gate.mjs",
          "package.json",
          "bun.lock",
          "packages/agent/**",
          "packages/app/**",
          "packages/app-core/**",
          "packages/core/**",
          "packages/native/plugins/**",
          "packages/shared/**",
          "plugins/plugin-sql/**",
        ],
        reason: "mobile app or runtime dependency",
      },
      {
        lanes: ["ios"],
        patterns: ["packages/app/ios/**", "packages/app-core/platforms/ios/**"],
        reason: "iOS native surface",
      },
      {
        lanes: ["android"],
        patterns: [
          "packages/app/android/**",
          "packages/app-core/platforms/android/**",
        ],
        reason: "Android native surface",
      },
    ],
  },
  "dev-smoke": {
    title: "Dev smoke path gate",
    outputs: ["dev_smoke"],
    labels: {
      "ci:full": ["dev_smoke"],
      "ci:dev-smoke": ["dev_smoke"],
      "ci:e2e": ["dev_smoke"],
    },
    rules: [
      {
        lanes: ["dev_smoke"],
        patterns: [
          ".github/workflows/dev-smoke.yml",
          ".github/actions/setup-bun-workspace/**",
          "packages/scripts/ci-path-gate.mjs",
          "package.json",
          "bun.lock",
          "packages/app/**",
          "packages/app-core/**",
          "packages/core/**",
          "packages/shared/**",
          "packages/ui/**",
        ],
        reason: "dev server or onboarding chat surface",
      },
    ],
  },
  "windows-dev": {
    title: "Windows dev smoke path gate",
    outputs: ["windows_dev"],
    labels: {
      "ci:full": ["windows_dev"],
      "ci:windows": ["windows_dev"],
      "ci:desktop": ["windows_dev"],
    },
    rules: [
      {
        lanes: ["windows_dev"],
        patterns: [
          ".github/workflows/windows-dev-smoke.yml",
          ".github/actions/setup-bun-workspace/**",
          "packages/scripts/ci-path-gate.mjs",
          "package.json",
          "bun.lock",
          "packages/app-core/scripts/**",
          "packages/app-core/platforms/electrobun/**",
          "packages/app/**",
        ],
        reason: "Windows dev bootstrap surface",
      },
    ],
  },
  "desktop-preload": {
    title: "Windows desktop preload path gate",
    outputs: ["desktop_preload"],
    labels: {
      "ci:full": ["desktop_preload"],
      "ci:windows": ["desktop_preload"],
      "ci:desktop": ["desktop_preload"],
    },
    rules: [
      {
        lanes: ["desktop_preload"],
        patterns: [
          ".github/workflows/windows-desktop-preload-smoke.yml",
          ".github/actions/setup-bun-workspace/**",
          "packages/scripts/ci-path-gate.mjs",
          "package.json",
          "bun.lock",
          "packages/app-core/scripts/**",
          "packages/app-core/platforms/electrobun/**",
          "packages/app/**",
        ],
        reason: "desktop preload or Electrobun surface",
      },
    ],
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
    .replaceAll(sentinel, ".*");
  return new RegExp(`^${escaped}$`);
}

const patternCache = new Map();
function matches(pattern, path) {
  if (!patternCache.has(pattern)) {
    patternCache.set(pattern, globToRegExp(pattern));
  }
  return patternCache.get(pattern).test(path);
}

function gitChangedFiles(base, head) {
  const result = spawnSync("git", ["diff", "--name-only", base, head], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git diff exited with ${result.status}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function addLane(matchesByLane, lane, source) {
  if (!matchesByLane.has(lane)) {
    matchesByLane.set(lane, []);
  }
  matchesByLane.get(lane).push(source);
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

  for (const path of changedFiles) {
    for (const rule of config.rules) {
      const pattern = rule.patterns.find((candidate) =>
        matches(candidate, path),
      );
      if (!pattern) {
        continue;
      }
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

main();
