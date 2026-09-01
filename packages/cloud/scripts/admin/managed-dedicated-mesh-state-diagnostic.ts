/**
 * Reads one failed managed-Dedicated canary's exact Docker locator and emits a
 * privacy-safe container/Tailscale state summary from the provisioning host.
 * Raw database identities, SSH output, container logs, and tailnet data never
 * cross the process boundary.
 */

import { Client } from "pg";
import { DockerSSHClient } from "../../shared/src/lib/services/docker-ssh";

const SUFFIX_PATTERN = /^r[1-9][0-9]{7,19}a[1-9][0-9]{0,3}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BACKEND_STATES = new Set([
  "NeedsLogin",
  "NeedsMachineAuth",
  "NoState",
  "Running",
  "Starting",
  "Stopped",
]);

type MeshLocator = {
  container_id: string | null;
  hostname: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  host_key_fingerprint: string | null;
};

type CommandObservation = { ok: boolean; output: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function classifyTailscaleStatus(output: string): {
  query: "success" | "error";
  backendState: string | null;
  machineAuthorized: boolean | null;
  authUrlPresent: boolean;
} {
  try {
    const status = record(JSON.parse(output));
    if (!status) throw new Error("status is not an object");
    const backendState =
      typeof status.BackendState === "string" &&
      BACKEND_STATES.has(status.BackendState)
        ? status.BackendState
        : null;
    const self = record(status.Self);
    return {
      query: "success",
      backendState,
      machineAuthorized:
        typeof self?.MachineAuthorized === "boolean"
          ? self.MachineAuthorized
          : null,
      authUrlPresent:
        typeof status.AuthURL === "string" && status.AuthURL.trim().length > 0,
    };
  } catch {
    // error-policy:J3 Raw CLI output is untrusted and becomes an explicit
    // closed diagnostic state rather than a fabricated healthy status.
    return {
      query: "error",
      backendState: null,
      machineAuthorized: null,
      authUrlPresent: false,
    };
  }
}

export function classifyContainerLogs(output: string): {
  authKeyRejected: boolean;
  interactiveAuthRequired: boolean;
  tailscaleUpFailed: boolean;
  agentStarted: boolean;
} {
  return {
    authKeyRejected:
      /(?:auth(?:entication)? key|authkey).*(?:invalid|expired|already used)|(?:invalid|expired|already used).*(?:auth(?:entication)? key|authkey)/i.test(
        output,
      ),
    interactiveAuthRequired: /https?:\/\/login\.tailscale\.com\//i.test(output),
    tailscaleUpFailed:
      /tailscale up failed|tailscale authentication failed/i.test(output),
    agentStarted:
      /starting (?:eliza|agent)|server (?:started|listening)|agent runtime started/i.test(
        output,
      ),
  };
}

async function observe(
  client: DockerSSHClient,
  command: string,
  timeoutMs = 20_000,
): Promise<CommandObservation> {
  try {
    return { ok: true, output: await client.exec(command, timeoutMs) };
  } catch {
    // error-policy:J1 The operator diagnostic reports only whether the exact
    // remote observation succeeded; raw SSH errors can contain private hosts.
    return { ok: false, output: "" };
  }
}

async function run(suffix: string): Promise<void> {
  if (!SUFFIX_PATTERN.test(suffix)) throw new Error("invalid canary suffix");
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this operator-only script runs outside Turbo under the protected worker EnvironmentFile.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  let rows: MeshLocator[];
  try {
    const result = await database.query<MeshLocator>(
      `SELECT
         sandbox.replacement_cleanup_container_id AS container_id,
         node.hostname,
         node.ssh_port,
         node.ssh_user,
         node.host_key_fingerprint
       FROM agent_sandboxes AS sandbox
       INNER JOIN docker_nodes AS node
         ON node.node_id = sandbox.replacement_cleanup_node_id
       WHERE sandbox.agent_name = $1`,
      [`managed-dedicated-canary-${suffix}`],
    );
    rows = result.rows;
  } finally {
    await database.end();
  }

  if (rows.length !== 1) {
    console.log(
      `MESH_DIAGNOSTIC=${JSON.stringify({ schemaVersion: 1, targetCount: rows.length })}`,
    );
    return;
  }
  const [locator] = rows;
  if (!locator) throw new Error("private mesh locator disappeared");
  if (
    typeof locator.container_id !== "string" ||
    !CONTAINER_ID_PATTERN.test(locator.container_id) ||
    typeof locator.hostname !== "string" ||
    !NODE_ID_PATTERN.test(locator.hostname) ||
    typeof locator.ssh_port !== "number" ||
    !Number.isInteger(locator.ssh_port) ||
    locator.ssh_port < 1 ||
    locator.ssh_port > 65_535 ||
    typeof locator.ssh_user !== "string" ||
    locator.ssh_user.trim().length === 0 ||
    typeof locator.host_key_fingerprint !== "string" ||
    locator.host_key_fingerprint.trim().length === 0
  ) {
    throw new Error("private mesh locator is incomplete or invalid");
  }

  const ssh = DockerSSHClient.getClient(
    locator.hostname,
    locator.ssh_port,
    locator.host_key_fingerprint,
    locator.ssh_user,
  );
  const id = locator.container_id;
  try {
    const [inspect, processState, status, ip, logs] = await Promise.all([
      observe(ssh, `docker inspect --format '{{json .State}}' ${id}`),
      observe(
        ssh,
        `docker exec ${id} sh -c 'test -S /tmp/tailscaled.sock && echo socket=present || echo socket=absent; pgrep -x tailscaled >/dev/null && echo daemon=present || echo daemon=absent'`,
      ),
      observe(
        ssh,
        `docker exec ${id} tailscale --socket=/tmp/tailscaled.sock status --json`,
      ),
      observe(
        ssh,
        `docker exec ${id} tailscale --socket=/tmp/tailscaled.sock ip -4`,
      ),
      observe(ssh, `docker logs --tail 400 ${id}`),
    ]);

    let state: Record<string, unknown> | null = null;
    if (inspect.ok) {
      try {
        state = record(JSON.parse(inspect.output));
      } catch {
        // error-policy:J3 Docker inspect output is untrusted; malformed state
        // remains an explicit unknown observation in the closed artifact.
        state = null;
      }
    }
    const containerStatus =
      typeof state?.Status === "string" &&
      [
        "created",
        "running",
        "paused",
        "restarting",
        "removing",
        "exited",
        "dead",
      ].includes(state.Status)
        ? state.Status
        : "unknown";
    const exitCode =
      typeof state?.ExitCode === "number" ? state.ExitCode : null;
    const tailscale = classifyTailscaleStatus(status.output);
    const logSignals = classifyContainerLogs(logs.output);
    console.log(
      `MESH_DIAGNOSTIC=${JSON.stringify({
        schemaVersion: 1,
        targetCount: 1,
        container: {
          inspect: inspect.ok ? "success" : "error",
          status: containerStatus,
          exitCode,
        },
        tailscale: {
          socketPresent:
            processState.ok &&
            /(?:^|\n)socket=present(?:\n|$)/.test(processState.output),
          daemonPresent:
            processState.ok &&
            /(?:^|\n)daemon=present(?:\n|$)/.test(processState.output),
          ...tailscale,
          ipPresent: ip.ok && ip.output.trim().length > 0,
        },
        logs: logSignals,
      })}`,
    );
  } finally {
    await ssh.disconnect();
  }
}

if (import.meta.main) {
  await run(process.argv[2] ?? "");
}
