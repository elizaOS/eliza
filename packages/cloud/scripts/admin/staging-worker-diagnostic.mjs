/**
 * Produces a closed, identifier-free summary of the deployed staging worker.
 * Only fixed service reads and a bounded journal tail are permitted; source and
 * process identity must remain stable throughout the read. Journal matches are
 * worker-wide observations and do not establish an individual agent's cause.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const UNIT = "eliza-provisioning-worker.service";
const CATEGORIES = {
  docker_health_timeout: /\[docker-sandbox\] Docker health check timed out/,
  tailnet_health_timeout: /\[docker-sandbox\] Tailnet health check timed out/,
  transport_unresolved: /remained transport-unresolved/,
  mesh_auth_rejected:
    /Container failed mesh join: headscale auth key expired\/rejected/,
  image_pull_failed: /\[docker-sandbox\] Image pull failed/,
  capacity_unavailable: /No Docker capacity and autoscale is not configured/,
  job_timeout: /\[provisioning-jobs\] Execution timed out/,
  health_diagnostics_unavailable:
    /Failed to collect health timeout diagnostics/,
};

export function summarizeJournal(text) {
  const counts = Object.fromEntries(
    Object.keys(CATEGORIES).map((key) => [key, 0]),
  );
  let records = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!entry || typeof entry.MESSAGE !== "string") {
      throw new Error("journal_format_invalid");
    }
    records += 1;
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
) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha))
    throw new Error("expected_source_invalid");
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
      `${JSON.stringify(collectDiagnostic(process.argv[2]))}\n`,
    );
  } catch {
    // error-policy:J1 Host failures may include private output; emit no raw error.
    process.stderr.write(
      "staging-worker-diagnostic: read failed; no private data emitted\n",
    );
    process.exitCode = 1;
  }
}
