import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const qaRoot = path.join(repoRoot, ".tmp", "qa");
fs.mkdirSync(qaRoot, { recursive: true });
const reportDir = fs.mkdtempSync(path.join(qaRoot, "docker-runtime-review-"));

function findDockerBin() {
  const candidates = [
    process.env.DOCKER_BIN,
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function runCommand(command, args, options = {}) {
  const { cwd = repoRoot, env = process.env, timeoutMs = 20_000 } = options;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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

function summarize(result) {
  const text = `${result.stdout}${result.stderr}`.trim();
  return text.length > 4000 ? text.slice(-4000) : text;
}

const dockerBin = findDockerBin();
const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  reportDir,
  dockerBin,
  daemonReady: false,
  status: "blocked",
  commands: {},
};

if (!dockerBin) {
  writeArtifact("report.json", `${JSON.stringify(report, null, 2)}\n`);
  writeArtifact(
    "report.md",
    `# Docker Runtime Review\n\nStatus: blocked\n\nNo Docker CLI binary was found.\n`,
  );
  console.log(
    "[docker-runtime-review] REPORT",
    JSON.stringify({ reportDir, status: report.status }),
  );
  process.exit(1);
}

const version = await runCommand(dockerBin, ["version"], { timeoutMs: 30_000 });
const context = await runCommand(dockerBin, ["context", "ls"], {
  timeoutMs: 15_000,
});
const desktopStatus = await runCommand(dockerBin, ["desktop", "status"], {
  timeoutMs: 15_000,
});
const info = await runCommand(dockerBin, ["info"], { timeoutMs: 20_000 });
const desktopLogs = await runCommand(
  dockerBin,
  ["desktop", "logs", "--priority", "2", "--boot", "0"],
  { timeoutMs: 20_000 },
);
const desktopDiagnose = await runCommand(dockerBin, ["desktop", "diagnose"], {
  timeoutMs: 20_000,
});

report.commands = {
  version,
  context,
  desktopStatus,
  info,
  desktopLogs,
  desktopDiagnose,
};
report.daemonReady = info.exitCode === 0;
report.status = report.daemonReady ? "ready" : "blocked";

let smoke = null;
if (report.daemonReady && process.env.ELIZA_DOCKER_REVIEW_RUN_SMOKE === "1") {
  smoke = await runCommand(
    "bash",
    [
      "eliza/packages/app-core/scripts/docker-ci-smoke.sh",
      ...(process.env.ELIZA_DOCKER_REVIEW_FULL_SMOKE === "1"
        ? []
        : ["--skip-smoke"]),
    ],
    { timeoutMs: 60 * 60_000 },
  );
  report.commands.smoke = smoke;
  if (smoke.exitCode !== 0) {
    report.status = "failed";
  }
}

writeArtifact("version.log", `${version.stdout}${version.stderr}`);
writeArtifact("context.log", `${context.stdout}${context.stderr}`);
writeArtifact(
  "desktop-status.log",
  `${desktopStatus.stdout}${desktopStatus.stderr}`,
);
writeArtifact("info.log", `${info.stdout}${info.stderr}`);
writeArtifact("desktop-logs.log", `${desktopLogs.stdout}${desktopLogs.stderr}`);
writeArtifact(
  "desktop-diagnose.log",
  `${desktopDiagnose.stdout}${desktopDiagnose.stderr}`,
);
if (smoke) {
  writeArtifact("smoke.log", `${smoke.stdout}${smoke.stderr}`);
}

const markdown = [
  "# Docker Runtime Review",
  "",
  `Status: ${report.status}`,
  `Generated: ${report.generatedAt}`,
  `Docker binary: ${dockerBin}`,
  "",
  "## Summary",
  "",
  `- docker version: exit ${version.exitCode}`,
  `- docker context ls: exit ${context.exitCode}`,
  `- docker desktop status: exit ${desktopStatus.exitCode}${desktopStatus.timedOut ? " (timed out)" : ""}`,
  `- docker info: exit ${info.exitCode}${info.timedOut ? " (timed out)" : ""}`,
  `- docker desktop diagnose: exit ${desktopDiagnose.exitCode}${desktopDiagnose.timedOut ? " (timed out)" : ""}`,
  ...(smoke
    ? [
        `- docker smoke: exit ${smoke.exitCode}${smoke.timedOut ? " (timed out)" : ""}`,
      ]
    : []),
  "",
  "## Tail",
  "",
  "### docker info",
  "",
  "```text",
  summarize(info),
  "```",
  "",
  "### docker desktop status",
  "",
  "```text",
  summarize(desktopStatus),
  "```",
  "",
  "### docker desktop diagnose",
  "",
  "```text",
  summarize(desktopDiagnose),
  "```",
].join("\n");

writeArtifact("report.json", `${JSON.stringify(report, null, 2)}\n`);
writeArtifact("report.md", `${markdown}\n`);

console.log(
  "[docker-runtime-review] REPORT",
  JSON.stringify({
    reportDir,
    status: report.status,
    daemonReady: report.daemonReady,
  }),
);

process.exit(
  report.status === "blocked" ? 2 : report.status === "failed" ? 1 : 0,
);
