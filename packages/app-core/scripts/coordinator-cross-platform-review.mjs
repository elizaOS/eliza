import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const qaRoot = path.join(repoRoot, ".tmp", "qa");
fs.mkdirSync(qaRoot, { recursive: true });
const reportDir = fs.mkdtempSync(
  path.join(qaRoot, `coordinator-platform-review-${process.platform}-`),
);

function runCommand(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    timeoutMs = 30 * 60_000,
  } = options;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        exitCode: code ?? -1,
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        exitCode: -1,
        signal: null,
        stdout,
        stderr: `${stderr}${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function writeArtifact(name, content) {
  const filePath = path.join(reportDir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

const checks = [
  {
    key: "orchestratorIntegration",
    command: "bun",
    args: ["run", "test:orchestrator:integration"],
    timeoutMs: 20 * 60_000,
  },
  {
    key: "taskPolicyAndDiscordUnits",
    command: "bun",
    args: [
      "test",
      "eliza/plugins/plugin-discord/__tests__/smoke.test.ts",
      "eliza/packages/core/src/agent-orchestrator/__tests__/task-policy.test.ts",
    ],
    timeoutMs: 10 * 60_000,
  },
  {
    key: "startupContract",
    command: "bun",
    args: ["run", "test:startup:contract"],
    timeoutMs: 10 * 60_000,
  },
];

const availabilityChecks = [
  {
    key: "codex",
    command: process.platform === "win32" ? "where" : "which",
    args: [process.platform === "win32" ? "codex.exe" : "codex"],
  },
  {
    key: "claude",
    command: process.platform === "win32" ? "where" : "which",
    args: [process.platform === "win32" ? "claude.exe" : "claude"],
  },
];

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  release: os.release(),
  arch: process.arch,
  reportDir,
  availability: {},
  checks: {},
  status: "pass",
};

for (const check of availabilityChecks) {
  const result = await runCommand(check.command, check.args, {
    timeoutMs: 10_000,
  });
  report.availability[check.key] = {
    exitCode: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

for (const check of checks) {
  const result = await runCommand(check.command, check.args, {
    timeoutMs: check.timeoutMs,
  });
  report.checks[check.key] = result;
  writeArtifact(`${check.key}.log`, `${result.stdout}${result.stderr}`);
  if (result.exitCode !== 0) {
    report.status = "fail";
  }
}

const markdown = [
  "# Coordinator Cross-Platform Review",
  "",
  `Generated: ${report.generatedAt}`,
  `Platform: ${report.platform}`,
  `Release: ${report.release}`,
  `Arch: ${report.arch}`,
  `Status: ${report.status}`,
  `Report dir: ${reportDir}`,
  "",
  "## Availability",
  "",
  ...Object.entries(report.availability).map(
    ([key, value]) =>
      `- ${key}: exit ${value.exitCode}${value.stdout ? ` (${value.stdout})` : ""}`,
  ),
  "",
  "## Checks",
  "",
  ...checks.flatMap((check) => {
    const result = report.checks[check.key];
    return [
      `### ${check.key}`,
      "",
      `- Exit: ${result.exitCode}`,
      `- Duration ms: ${result.durationMs}`,
      `- Timed out: ${result.timedOut}`,
      `- Log: ${path.join(reportDir, `${check.key}.log`)}`,
      "",
    ];
  }),
].join("\n");

writeArtifact("report.json", `${JSON.stringify(report, null, 2)}\n`);
writeArtifact("report.md", `${markdown}\n`);

console.log(
  "[coordinator-cross-platform-review] REPORT",
  JSON.stringify({
    reportDir,
    platform: report.platform,
    status: report.status,
  }),
);

process.exit(report.status === "pass" ? 0 : 1);
