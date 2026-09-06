/**
 * Produces a closed, identifier-free summary of the deployed staging worker.
 * Only fixed service reads and a bounded journal tail are permitted; source and
 * process identity must remain stable throughout the read. Journal matches are
 * worker-wide observations and do not establish an individual agent's cause.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const UNIT = "eliza-provisioning-worker.service";
const CATEGORIES = {
  docker_health_timeout: /\[docker-sandbox\] Docker health check timed out/,
  tailnet_health_timeout: /\[docker-sandbox\] Tailnet health check timed out/,
  health_timeout_diagnostics: /\[docker-sandbox\] Health timeout diagnostics/,
  transport_unresolved: /remained transport-unresolved/,
  mesh_auth_rejected:
    /Container failed mesh join: headscale auth key expired\/rejected/,
  image_pull_failed: /\[docker-sandbox\] Image pull failed/,
  capacity_unavailable: /No Docker capacity and autoscale is not configured/,
  job_timeout: /\[provisioning-jobs\] Execution timed out/,
  health_diagnostics_unavailable:
    /Failed to collect health timeout diagnostics/,
};

// These are complete worker messages, never substrings of container diagnostics.
const TARGET_HEALTH_TIMEOUTS = {
  docker:
    /^\[docker-sandbox\] Docker health check timed out after [0-9]+(?:\.[0-9]+)?s for (agent-[A-Za-z0-9_.-]+) on [^\r\n]+$/,
  tailnet:
    /^\[docker-sandbox\] Tailnet health check timed out after [0-9]+(?:\.[0-9]+)?s for (agent-[A-Za-z0-9_.-]+) \([^\r\n]+\)$/,
};

const BOOT_SIGNALS = {
  module_resolution: /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/,
  address_in_use: /EADDRINUSE/,
  permission_denied: /EACCES|permission denied/i,
  database_authentication: /password authentication failed|28P01/,
  database_schema: /relation [^\n]+ does not exist|42P01/,
  out_of_memory: /out of memory|OutOfMemory|OOMKilled/,
};

function healthSummary() {
  return { frames: 0, malformedFrames: 0, observations: [] };
}

function healthObservation(diagnostics) {
  const inspect = diagnostics.split("--- authkey marker ---")[0];
  const state =
    /^state=(created|running|paused|restarting|removing|exited|dead) health=(healthy|unhealthy|starting|) exit=([0-9]{1,3}) error=([^\n]*)$/m.exec(
      inspect,
    );
  const missing = /No such (?:object|container)/i.test(inspect);
  const logMarker = "--- logs ---\n";
  const logStart = diagnostics.indexOf(logMarker);
  // Section framing is removed losslessly; every byte after the first log
  // marker remains available to the classifier, including repeated markers.
  const logs =
    logStart < 0 ? undefined : diagnostics.slice(logStart + logMarker.length);
  const authSection = diagnostics.split("--- authkey marker ---\n")[1];
  const marker =
    authSection === undefined
      ? null
      : /^authkey-marker=(present|absent|unknown)$/m.exec(
          authSection.split("--- ports ---\n")[0].split(logMarker)[0],
        );
  return {
    containerState: state ? state[1] : missing ? "missing" : "unavailable",
    health: state ? state[2] || "unavailable" : "unavailable",
    exitCode: state && Number(state[3]) <= 255 ? Number(state[3]) : null,
    inspectErrorPresent: state ? state[4].length > 0 : null,
    authKeyMarker: marker ? marker[1] : "unknown",
    bootSignals:
      logs === undefined
        ? null
        : Object.fromEntries(
            Object.entries(BOOT_SIGNALS).map(([key, pattern]) => [
              key,
              pattern.test(logs),
            ]),
          ),
  };
}

/** Parses only complete console frames; unexpected/interleaved lines discard attribution. */
export function summarizeHealthFrames(messages, targetDigest) {
  const all = healthSummary();
  const target = targetDigest ? { frames: 0, observations: [] } : null;
  let frame = [];
  for (const message of messages) {
    for (const line of message.split("\n")) {
      if (line === "[docker-sandbox] Health timeout diagnostics {") {
        if (frame.length) all.malformedFrames += 1;
        frame = [line];
        continue;
      }
      if (!frame.length) continue;
      const expected = [
        null,
        /^ {2}containerName: "agent-[A-Za-z0-9_.-]+",$/,
        /^ {2}nodeId: "(?:[^"\\]|\\.)*",$/,
        /^ {2}diagnostics: "(?:[^"\\]|\\.)*",$/,
        /^}$/,
      ][frame.length];
      if (!expected?.test(line)) {
        all.malformedFrames += 1;
        frame = [];
        continue;
      }
      frame.push(line);
      if (frame.length !== 5) continue;
      try {
        const container = JSON.parse(
          frame[1].slice("  containerName: ".length, -1),
        );
        const diagnostics = JSON.parse(
          frame[3].slice("  diagnostics: ".length, -1),
        );
        const observation = healthObservation(diagnostics);
        all.frames += 1;
        all.observations.push(observation);
        if (
          target &&
          createHash("sha256").update(container).digest("hex") === targetDigest
        ) {
          target.frames += 1;
          target.observations.push(observation);
        }
      } catch {
        // error-policy:J3 Unsupported console escaping is explicitly unparsed, never evaluated.
        all.malformedFrames += 1;
      }
      frame = [];
    }
  }
  if (frame.length) all.malformedFrames += 1;
  return { association: "complete-adjacent-worker-log-frame", all, target };
}

export function summarizeJournal(text, targetDigest) {
  if (targetDigest !== undefined && !/^[0-9a-f]{64}$/.test(targetDigest))
    throw new Error("target_digest_invalid");
  const counts = Object.fromEntries(
    Object.keys(CATEGORIES).map((key) => [key, 0]),
  );
  let records = 0;
  const messages = [];
  const targetHealthTimeouts = targetDigest ? { docker: 0, tailnet: 0 } : null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!entry || typeof entry.MESSAGE !== "string") {
      throw new Error("journal_format_invalid");
    }
    records += 1;
    messages.push(entry.MESSAGE);
    if (targetHealthTimeouts) {
      for (const [kind, pattern] of Object.entries(TARGET_HEALTH_TIMEOUTS)) {
        const timeout = pattern.exec(entry.MESSAGE);
        if (
          timeout &&
          createHash("sha256").update(timeout[1]).digest("hex") === targetDigest
        )
          targetHealthTimeouts[kind] += 1;
      }
    }
    for (const [category, pattern] of Object.entries(CATEGORIES)) {
      if (pattern.test(entry.MESSAGE)) counts[category] += 1;
    }
  }
  return {
    scope: "worker-wide-not-agent-specific",
    windowHours: 24,
    tailLimit: 10000,
    records,
    counts,
    targetHealthTimeouts,
    healthTimeouts: summarizeHealthFrames(messages, targetDigest),
  };
}

export function summarizeImage(environment) {
  const pins = environment
    .split("\0")
    .filter((entry) => entry.startsWith("ELIZA_AGENT_IMAGE="));
  if (pins.length !== 1) throw new Error("image_pin_missing_or_ambiguous");
  const match =
    /^ELIZA_AGENT_IMAGE=ghcr\.io\/elizaos\/(eliza|eliza-demo)@(sha256:[0-9a-f]{64})$/.exec(
      pins[0],
    );
  if (!match) return { family: "other", digest: null };
  return {
    family: match[1] === "eliza-demo" ? "demo" : "canonical",
    digest: match[2],
  };
}

function command(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
  if (result.error || result.status !== 0) throw new Error("host_read_failed");
  return result.stdout;
}

export function collectDiagnostic(
  expectedSha,
  run = command,
  readEnvironment = (pid) => readFileSync(`/proc/${pid}/environ`, "utf8"),
  targetDigest,
) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha))
    throw new Error("expected_source_invalid");
  if (targetDigest !== undefined && !/^[0-9a-f]{64}$/.test(targetDigest))
    throw new Error("target_digest_invalid");
  const source = () =>
    run("/usr/bin/git", [
      "-c",
      "safe.directory=/opt/eliza",
      "-C",
      "/opt/eliza",
      "rev-parse",
      "HEAD",
    ]).trim();
  const property = (name) =>
    run("/usr/bin/systemctl", [
      "show",
      UNIT,
      `--property=${name}`,
      "--value",
    ]).trim();
  if (source() !== expectedSha) throw new Error("deployed_source_mismatch");
  const pid = property("MainPID");
  if (!/^[1-9][0-9]{0,9}$/.test(pid))
    throw new Error("worker_process_unavailable");
  const active = property("ActiveState");
  if (active !== "active") throw new Error("worker_not_active");
  const image = summarizeImage(readEnvironment(pid));
  const journal = summarizeJournal(
    run("/usr/bin/sudo", [
      "-n",
      "/usr/bin/journalctl",
      "--unit",
      UNIT,
      "--since",
      "24 hours ago",
      "--lines=10000",
      "--output=json",
      "--output-fields=MESSAGE",
      "--no-pager",
      "--quiet",
    ]),
    targetDigest,
  );
  if (
    source() !== expectedSha ||
    property("MainPID") !== pid ||
    property("ActiveState") !== "active"
  )
    throw new Error("worker_changed_during_read");
  return {
    schemaVersion: 1,
    kind: "staging-worker-readonly",
    sourceCommit: expectedSha,
    service: "active",
    image,
    journal,
  };
}

if (process.argv[1] === "-") {
  try {
    process.stdout.write(
      `${JSON.stringify(collectDiagnostic(process.argv[2], undefined, undefined, process.argv[3] || undefined))}\n`,
    );
  } catch {
    // error-policy:J1 Host failures may include private output; emit no raw error.
    process.stderr.write(
      "staging-worker-diagnostic: read failed; no private data emitted\n",
    );
    process.exitCode = 1;
  }
}
