#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
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
  "benchmark-analysis",
  "gap-evidence",
);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function dockerProbe() {
  const completed = run("docker", ["version", "--format", "{{json .}}"]);
  let clientVersion = "";
  let serverAvailable = false;
  try {
    const firstLine = String(completed.stdout || "").split(/\r?\n/)[0];
    const parsed = firstLine ? JSON.parse(firstLine) : {};
    clientVersion = String(parsed?.Client?.Version || "");
    serverAvailable = Boolean(parsed?.Server);
  } catch {
    // Keep the raw failure classified without preserving potentially noisy output.
  }
  return {
    command: "docker version --format <json>",
    exitCode: completed.status,
    clientVersion,
    serverAvailable,
    daemonSocket:
      process.env.DOCKER_HOST ||
      "unix:///Users/shawwalters/.docker/run/docker.sock",
    failureSummary: serverAvailable
      ? ""
      : "Docker daemon is not reachable from this environment.",
  };
}

function commandProbe(command, args = ["--version"]) {
  const completed = run(command, args);
  return {
    command: [command, ...args].join(" "),
    exitCode: completed.status,
    available: completed.status === 0,
    summary: String(completed.stdout || completed.stderr || "").split(/\r?\n/)[0] || "",
  };
}

function localVmFileProbe() {
  const home = os.homedir();
  const completed = run("find", [
    home,
    "-maxdepth",
    "4",
    "(",
    "-name",
    "*.vmx",
    "-o",
    "-name",
    "*.vbox",
    ")",
  ]);
  const files = String(completed.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 25);
  return {
    command: "find $HOME -maxdepth 4 \\( -name *.vmx -o -name *.vbox \\)",
    exitCode: completed.status,
    files,
    vmxCount: files.filter((file) => file.endsWith(".vmx")).length,
    vboxCount: files.filter((file) => file.endsWith(".vbox")).length,
  };
}

function envProbe() {
  const osworldKeys = Object.keys(process.env)
    .filter((key) => key.startsWith("OSWORLD_"))
    .sort();
  const awsKeys = Object.keys(process.env)
    .filter((key) => key.startsWith("AWS_"))
    .sort();
  return {
    osworldKeyCount: osworldKeys.length,
    osworldKeys,
    awsKeyCount: awsKeys.length,
    awsKeys,
    hasOsworldProvider:
      Boolean(process.env.OSWORLD_PROVIDER_NAME) ||
      Boolean(process.env.OSWORLD_PATH_TO_VM),
    hasAwsProvider:
      Boolean(process.env.AWS_ACCESS_KEY_ID) &&
      Boolean(process.env.AWS_SECRET_ACCESS_KEY),
  };
}

function credentialProbe() {
  return {
    cerebrasApiKeyPresent: Boolean(process.env.CEREBRAS_API_KEY),
    hyperliquidPrivateKeyPresent: Boolean(process.env.HL_PRIVATE_KEY),
    awsAccessKeyIdPresent: Boolean(process.env.AWS_ACCESS_KEY_ID),
    awsSecretAccessKeyPresent: Boolean(process.env.AWS_SECRET_ACCESS_KEY),
    note: "Presence only; secret values are not persisted.",
  };
}

function providerProbe(docker, env) {
  const vmware = commandProbe("vmrun", ["-T", "ws", "list"]);
  const virtualbox = commandProbe("VBoxManage", ["--version"]);
  const vmFiles = localVmFileProbe();
  const providers = {
    docker: {
      runnable: Boolean(docker.serverAvailable),
      detail: docker.serverAvailable ? "Docker daemon reachable." : docker.failureSummary,
    },
    vmware: {
      runnable: Boolean(vmware.available && (env.hasOsworldProvider || vmFiles.vmxCount > 0)),
      detail: vmware.available
        ? `${vmFiles.vmxCount} .vmx files found within $HOME depth 4.`
        : "vmrun is not available.",
    },
    virtualbox: {
      runnable: Boolean(virtualbox.available && vmFiles.vboxCount > 0),
      detail: virtualbox.available
        ? `${vmFiles.vboxCount} .vbox files found within $HOME depth 4.`
        : "VBoxManage is not available.",
    },
    aws: {
      runnable: Boolean(env.hasAwsProvider),
      detail: env.hasAwsProvider
        ? "AWS credentials are present."
        : "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not both configured.",
    },
  };
  return {
    vmware,
    virtualbox,
    vmFiles,
    providers,
    runnableProviderCount: Object.values(providers).filter((provider) => provider.runnable).length,
  };
}

function remediationCommands() {
  return {
    osworld: [
      {
        id: "rerun-osworld-after-provider-ready",
        command:
          "PYTHONPATH=. python -m benchmarks.orchestrator run --benchmarks osworld --all-harnesses --provider cerebras --model gpt-oss-120b --max-tasks 5 --force --show-incompatible",
        requires: [
          "CEREBRAS_API_KEY present",
          "One runnable OSWorld provider: Docker daemon, VMware, VirtualBox, or AWS",
        ],
        followedBy: "bun run bench:analysis:build",
      },
    ],
    hyperliquid: [
      {
        id: "rerun-hyperliquid-after-key-ready",
        command:
          "HL_PRIVATE_KEY=<set-in-shell> VISION_LANGUAGE_PROVIDER=local-eliza VISION_LANGUAGE_MODEL=eliza-1-9b VISION_LANGUAGE_TIER=eliza-1-9b PYTHONPATH=. python -m benchmarks.orchestrator run --benchmarks hyperliquid_bench --all-harnesses --provider cerebras --model gpt-oss-120b --force --show-incompatible",
        requires: ["CEREBRAS_API_KEY present", "HL_PRIVATE_KEY present"],
        followedBy: "bun run bench:analysis:build",
      },
    ],
  };
}

function datasetProbe() {
  const code = String.raw`
import json
from benchmarks.claw_eval_matrix.code_agent_matrix import available_task_count as claw_count, load_tasks as claw_tasks
from benchmarks.qwen_claw_bench_matrix.code_agent_matrix import available_task_count as qwen_count, load_tasks as qwen_tasks
from benchmarks.openclaw_benchmark.code_agent_matrix import available_scenario_names

payload = {
    "claw_eval": {
        "available": claw_count(),
        "items": [task.get("task_id") for task in claw_tasks(max_tasks=None)],
        "limit_reason": "local Claw-Eval wrapper discovers supported non-LLM deterministic YAML tasks",
    },
    "qwen_claw_bench": {
        "available": qwen_count(),
        "items": [getattr(task, "task_id", "") for task in qwen_tasks(max_tasks=None)],
        "limit_reason": "local QwenClawBench wrapper supports automated and hybrid tasks; hybrid tasks use the configured live LLM judge",
    },
    "openclaw_benchmark": {
        "available": len(available_scenario_names()),
        "items": available_scenario_names(),
        "limit_reason": "local OpenCLAW benchmark runner exposes five ordered scenarios after materializing Weather CLI standard PRD tasks",
    },
}
print(json.dumps(payload, sort_keys=True))
`;
  const completed = run("python", ["-c", code], {
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(REPO_ROOT, "packages"),
        path.join(REPO_ROOT, "packages", "benchmarks"),
        process.env.PYTHONPATH || "",
      ]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });
  if (completed.status !== 0) {
    return {
      exitCode: completed.status,
      error: String(completed.stderr || completed.stdout || "dataset probe failed").slice(0, 1000),
      benchmarks: {},
    };
  }
  return {
    exitCode: 0,
    benchmarks: JSON.parse(String(completed.stdout || "{}")),
  };
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Gap Evidence</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; margin-bottom:12px; overflow:hidden; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .bad { color:#a12222; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Benchmark Gap Evidence</h1><div id="meta"></div></header>
  <main>
    <section class="panel"><h2>OSWorld Runtime Prerequisites</h2><div id="osworld"></div></section>
    <section class="panel"><h2>Credential Presence</h2><div id="credentials"></div></section>
    <section class="panel"><h2>Rerun Commands</h2><div id="commands"></div></section>
    <section class="panel"><h2>Expanded Local Slices</h2><div id="datasets"></div></section>
  </main>
  <script src="./gap-evidence-data.js"></script>
  <script>
    const data = window.BENCHMARK_GAP_EVIDENCE || {};
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById("meta").textContent = data.generatedAt || "";
    const os = data.osworld || {};
    document.getElementById("osworld").innerHTML = '<table><tbody>' +
      '<tr><th>Docker client</th><td>' + esc(os.docker?.clientVersion || "not detected") + '</td></tr>' +
      '<tr><th>Docker daemon</th><td class="' + (os.docker?.serverAvailable ? 'ok' : 'bad') + '">' + esc(os.docker?.serverAvailable ? 'reachable' : 'unreachable') + '</td></tr>' +
      '<tr><th>Daemon socket</th><td><code>' + esc(os.docker?.daemonSocket) + '</code></td></tr>' +
      '<tr><th>Runnable providers</th><td class="' + ((os.providerReadiness?.runnableProviderCount || 0) > 0 ? 'ok' : 'bad') + '">' + esc(os.providerReadiness?.runnableProviderCount || 0) + '</td></tr>' +
      '<tr><th>VMware</th><td>' + esc(os.providerReadiness?.providers?.vmware?.detail || "") + '</td></tr>' +
      '<tr><th>VirtualBox</th><td>' + esc(os.providerReadiness?.providers?.virtualbox?.detail || "") + '</td></tr>' +
      '<tr><th>AWS</th><td>' + esc(os.providerReadiness?.providers?.aws?.detail || "") + '</td></tr>' +
      '<tr><th>OSWORLD env keys</th><td>' + esc((os.env?.osworldKeys || []).join(", ") || "none") + '</td></tr>' +
      '<tr><th>AWS env keys</th><td>' + esc((os.env?.awsKeys || []).join(", ") || "none") + '</td></tr>' +
      '<tr><th>summary</th><td>' + esc(os.blockerSummary) + '</td></tr>' +
      '</tbody></table>';
    const c = data.credentials || {};
    document.getElementById("credentials").innerHTML = '<table><tbody>' +
      '<tr><th>CEREBRAS_API_KEY</th><td class="' + (c.cerebrasApiKeyPresent ? 'ok' : 'bad') + '">' + esc(c.cerebrasApiKeyPresent ? 'present' : 'missing') + '</td></tr>' +
      '<tr><th>HL_PRIVATE_KEY</th><td class="' + (c.hyperliquidPrivateKeyPresent ? 'ok' : 'bad') + '">' + esc(c.hyperliquidPrivateKeyPresent ? 'present' : 'missing') + '</td></tr>' +
      '<tr><th>AWS_ACCESS_KEY_ID</th><td class="' + (c.awsAccessKeyIdPresent ? 'ok' : 'bad') + '">' + esc(c.awsAccessKeyIdPresent ? 'present' : 'missing') + '</td></tr>' +
      '<tr><th>AWS_SECRET_ACCESS_KEY</th><td class="' + (c.awsSecretAccessKeyPresent ? 'ok' : 'bad') + '">' + esc(c.awsSecretAccessKeyPresent ? 'present' : 'missing') + '</td></tr>' +
      '<tr><th>note</th><td>' + esc(c.note || '') + '</td></tr>' +
      '</tbody></table>';
    const commandRows = Object.entries(data.remediationCommands || {}).flatMap(([gate, commands]) => (commands || []).map(command => ({gate, ...command})));
    document.getElementById("commands").innerHTML = '<table><thead><tr><th>gate</th><th>command</th><th>requires</th><th>then</th></tr></thead><tbody>' + commandRows.map(row => '<tr><td><code>' + esc(row.gate) + '</code></td><td><code>' + esc(row.command) + '</code></td><td>' + esc((row.requires || []).join("; ")) + '</td><td><code>' + esc(row.followedBy || '') + '</code></td></tr>').join("") + '</tbody></table>';
    const rows = Object.entries(data.underFiveBenchmarks || {}).map(([name, b]) => '<tr><td><code>' + esc(name) + '</code></td><td>' + esc(b.available) + '</td><td>' + esc((b.items || []).join(", ")) + '</td><td>' + esc(b.limit_reason) + '</td></tr>').join("");
    document.getElementById("datasets").innerHTML = '<table><thead><tr><th>benchmark</th><th>available</th><th>items</th><th>limit reason</th></tr></thead><tbody>' + rows + '</tbody></table>';
  </script>
</body>
</html>`;
}

function osworldReadinessHtml(payload) {
  const osworld = payload.osworld || {};
  const providers = osworld.providerReadiness?.providers || {};
  const setupRows = [
    [
      "Docker",
      providers.docker?.runnable ? "ready" : "blocked",
      providers.docker?.detail || "",
      "Start Docker Desktop or another Docker daemon reachable at the configured Docker socket, then rerun the benchmark analysis build.",
    ],
    [
      "VMware",
      providers.vmware?.runnable ? "ready" : "blocked",
      providers.vmware?.detail || "",
      "Install vmrun and configure OSWORLD_PROVIDER_NAME/OSWORLD_PATH_TO_VM or place a .vmx file within the probed home-directory depth.",
    ],
    [
      "VirtualBox",
      providers.virtualbox?.runnable ? "ready" : "blocked",
      providers.virtualbox?.detail || "",
      "Install VBoxManage and configure a discoverable .vbox VM for OSWorld.",
    ],
    [
      "AWS",
      providers.aws?.runnable ? "ready" : "blocked",
      providers.aws?.detail || "",
      "Configure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY if using an AWS-backed OSWorld provider.",
    ],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OSWorld Live Readiness</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; margin-bottom:12px; overflow:hidden; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .bad { color:#a12222; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
    .muted { color:#5e675d; }
  </style>
</head>
<body>
  <header><h1>OSWorld Live Readiness</h1><div class="muted">${payload.generatedAt}</div></header>
  <main>
    <section class="panel"><h2>Current Blocker</h2><div class="body"><strong class="${osworld.providerReadiness?.runnableProviderCount > 0 ? "ok" : "bad"}">${osworld.providerReadiness?.runnableProviderCount || 0} runnable provider(s)</strong><p>${osworld.blockerSummary}</p></div></section>
    <section class="panel"><h2>Provider Checklist</h2><div class="body"><table><thead><tr><th>provider</th><th>status</th><th>probe detail</th><th>next action</th></tr></thead><tbody>${setupRows
      .map(
        ([provider, status, detail, action]) =>
          `<tr><td>${provider}</td><td class="${status === "ready" ? "ok" : "bad"}">${status}</td><td>${detail}</td><td>${action}</td></tr>`,
      )
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Probe Evidence</h2><div class="body"><table><tbody>
      <tr><th>Docker command</th><td><code>${osworld.docker?.command || ""}</code></td></tr>
      <tr><th>Docker exit</th><td>${osworld.docker?.exitCode ?? ""}</td></tr>
      <tr><th>Docker client</th><td>${osworld.docker?.clientVersion || "not detected"}</td></tr>
      <tr><th>Docker socket</th><td><code>${osworld.docker?.daemonSocket || ""}</code></td></tr>
      <tr><th>VMware command</th><td><code>${osworld.providerReadiness?.vmware?.command || ""}</code></td></tr>
      <tr><th>VirtualBox command</th><td><code>${osworld.providerReadiness?.virtualbox?.command || ""}</code></td></tr>
      <tr><th>VM file probe</th><td><code>${osworld.providerReadiness?.vmFiles?.command || ""}</code>; ${osworld.providerReadiness?.vmFiles?.vmxCount || 0} .vmx, ${osworld.providerReadiness?.vmFiles?.vboxCount || 0} .vbox</td></tr>
      <tr><th>OSWORLD env keys</th><td>${(osworld.env?.osworldKeys || []).join(", ") || "none"}</td></tr>
      <tr><th>AWS env keys</th><td>${(osworld.env?.awsKeys || []).join(", ") || "none"}</td></tr>
    </tbody></table></div></section>
    <section class="panel"><h2>Rerun Gate</h2><div class="body">After at least one provider is ready, run <code>bun run bench:analysis:build</code>. The verifier expects OSWorld to remain a known caveat until a real live-scored OSWorld row replaces the current smoke-only evidence.</div></section>
    <section class="panel"><h2>Rerun Command</h2><div class="body"><code>${(payload.remediationCommands?.osworld || [])[0]?.command || ""}</code><p class="muted">Then run <code>bun run bench:analysis:build</code> to mirror artifacts, regenerate playback, and update the goal audit.</p></div></section>
  </main>
</body>
</html>`;
}

function renderMarkdown(payload) {
  const lines = [
    "# Benchmark Gap Evidence",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "## OSWorld",
    "",
    `Docker client version: ${payload.osworld.docker.clientVersion || "not detected"}`,
    `Docker daemon reachable: ${payload.osworld.docker.serverAvailable ? "yes" : "no"}`,
    `Daemon socket: ${payload.osworld.docker.daemonSocket}`,
    `Runnable OSWorld providers: ${payload.osworld.providerReadiness.runnableProviderCount}`,
    `VMware: ${payload.osworld.providerReadiness.providers.vmware.detail}`,
    `VirtualBox: ${payload.osworld.providerReadiness.providers.virtualbox.detail}`,
    `AWS: ${payload.osworld.providerReadiness.providers.aws.detail}`,
    `OSWORLD env keys: ${payload.osworld.env.osworldKeys.join(", ") || "none"}`,
    `AWS env keys: ${payload.osworld.env.awsKeys.join(", ") || "none"}`,
    `Blocker: ${payload.osworld.blockerSummary}`,
    "",
    "## Credential Presence",
    "",
    `CEREBRAS_API_KEY: ${payload.credentials.cerebrasApiKeyPresent ? "present" : "missing"}`,
    `HL_PRIVATE_KEY: ${payload.credentials.hyperliquidPrivateKeyPresent ? "present" : "missing"}`,
    `AWS_ACCESS_KEY_ID: ${payload.credentials.awsAccessKeyIdPresent ? "present" : "missing"}`,
    `AWS_SECRET_ACCESS_KEY: ${payload.credentials.awsSecretAccessKeyPresent ? "present" : "missing"}`,
    payload.credentials.note,
    "",
    "## Rerun Commands",
    "",
    ...Object.entries(payload.remediationCommands || {}).flatMap(([gate, commands]) =>
      (commands || []).map(
        (command) =>
          `- \`${gate}\` / \`${command.id}\`: \`${command.command}\`; requires ${command.requires.join(", ")}; then \`${command.followedBy}\``,
      ),
    ),
    "",
    "## Expanded Local Slices",
    "",
    "| benchmark | available | items | limit reason |",
    "|---|---:|---|---|",
  ];
  for (const [name, data] of Object.entries(payload.underFiveBenchmarks)) {
    lines.push(
      `| \`${name}\` | ${data.available} | ${(data.items || []).join(", ")} | ${data.limit_reason} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  mkdirSync(DEFAULT_REPORT_DIR, { recursive: true });
  const docker = dockerProbe();
  const env = envProbe();
  const credentials = credentialProbe();
  const providerReadiness = providerProbe(docker, env);
  const datasets = datasetProbe();
  const payload = {
    schema: "eliza_benchmark_gap_evidence_v1",
    generatedAt: new Date().toISOString(),
    osworld: {
      docker,
      env,
      providerReadiness,
      blockerSummary:
        providerReadiness.runnableProviderCount > 0
          ? "OSWorld prerequisites may be satisfiable; rerun live scoring."
          : "No runnable OSWorld provider is configured: Docker daemon is unreachable, vmrun/VBoxManage are unavailable or have no VM file, and AWS credentials are absent.",
    },
    credentials,
    remediationCommands: remediationCommands(),
    underFiveBenchmarks: datasets.benchmarks,
  };
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "gap-evidence.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "gap-evidence-data.js"),
    `window.BENCHMARK_GAP_EVIDENCE = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(path.join(DEFAULT_REPORT_DIR, "README.md"), renderMarkdown(payload), "utf8");
  writeFileSync(path.join(DEFAULT_REPORT_DIR, "index.html"), html(), "utf8");
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "osworld-live-readiness.html"),
    osworldReadinessHtml(payload),
    "utf8",
  );
  process.stdout.write(
    `benchmark gap evidence: osworld daemon=${docker.serverAvailable ? "yes" : "no"}; tracked-slices=${Object.keys(datasets.benchmarks || {}).length}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
