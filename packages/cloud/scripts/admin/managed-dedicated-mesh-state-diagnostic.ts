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
const CONTAINER_NAME_PATTERN =
  /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  container_ref: string | null;
  hostname: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  host_key_fingerprint: string | null;
};

type CommandObservation = { ok: boolean; output: string };

type RuntimeProcessState = {
  pid1: "agent" | "entrypoint" | "other" | "tailscale-up" | "unknown";
  agentProcessPresent: boolean;
  entrypointProcessPresent: boolean;
  tailscaleUpProcessPresent: boolean;
  forceNoise443Enabled: boolean;
  stuckCliEscapePresent: boolean;
};

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

export function classifyRuntimeProcessState(
  output: string,
): RuntimeProcessState {
  const facts = new Map(
    output
      .split("\n")
      .map((line) => line.trim().split("=", 2))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const pid1 = facts.get("pid1");
  return {
    pid1:
      pid1 === "agent" ||
      pid1 === "entrypoint" ||
      pid1 === "other" ||
      pid1 === "tailscale-up"
        ? pid1
        : "unknown",
    agentProcessPresent: facts.get("agent") === "present",
    entrypointProcessPresent: facts.get("entrypoint") === "present",
    tailscaleUpProcessPresent: facts.get("tailscale_up") === "present",
    forceNoise443Enabled: facts.get("force_noise_443") === "enabled",
    stuckCliEscapePresent: facts.get("stuck_cli_escape") === "present",
  };
}

async function observe(
  client: DockerSSHClient,
  command: string,
  timeoutMs = 8_000,
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
      `WITH target AS (
         SELECT
           *,
           COALESCE(
             replacement_cleanup_container_id,
             activation_container_id,
             CASE WHEN sandbox_id ~ '^[0-9a-f]{12,64}$' THEN sandbox_id END,
             replacement_cleanup_container_name,
             container_name
           ) AS diagnostic_container_ref,
           COALESCE(replacement_cleanup_node_id, activation_node_id, node_id)
             AS diagnostic_node_id
         FROM agent_sandboxes
         WHERE agent_name = $1
       )
       SELECT
         sandbox.diagnostic_container_ref AS container_ref,
         node.hostname,
         node.ssh_port,
         node.ssh_user,
         node.host_key_fingerprint
       FROM target AS sandbox
       INNER JOIN docker_nodes AS node
         ON node.node_id = sandbox.diagnostic_node_id
       WHERE sandbox.diagnostic_container_ref IS NOT NULL`,
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
    typeof locator.container_ref !== "string" ||
    (!CONTAINER_ID_PATTERN.test(locator.container_ref) &&
      !CONTAINER_NAME_PATTERN.test(locator.container_ref)) ||
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
  const id = locator.container_ref;
  try {
    // One pooled SSH client is intentionally observed serially. Concurrent
    // first-use execs can each attempt to establish the same session and keep
    // the operator probe alive past its outer workflow deadline.
    const inspect = await observe(
      ssh,
      `docker inspect --format '{{json .State}}' ${id}`,
    );
    const processState = await observe(
      ssh,
      `docker exec ${id} sh -c 'test -S /tmp/tailscaled.sock && echo socket=present || echo socket=absent; pgrep -x tailscaled >/dev/null && echo daemon=present || echo daemon=absent'`,
    );
    const status = await observe(
      ssh,
      `docker exec ${id} tailscale --socket=/tmp/tailscaled.sock status --json`,
    );
    const ip = await observe(
      ssh,
      `docker exec ${id} tailscale --socket=/tmp/tailscaled.sock ip -4`,
    );
    const runtime = await observe(
      ssh,
      `docker exec ${id} sh -c '
        pid1=other
        agent=absent
        entrypoint=absent
        tailscale_up=absent
        for f in /proc/[0-9]*/cmdline; do
          pid=$(printf "%s" "$f" | cut -d/ -f3)
          [ "$pid" = "$$" ] && continue
          cmd=$(tr "\\000" " " < "$f" 2>/dev/null || true)
          exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
          case "$cmd" in *docker-entrypoint.sh*) entrypoint=present ;; esac
          case "$cmd" in *packages/agent/dist/bin.js*start*) agent=present ;; esac
          case "$exe:$cmd" in */tailscale:*" up "*) tailscale_up=present ;; esac
          if [ "$pid" = "1" ]; then
            case "$exe:$cmd" in
              */tailscale:*" up "*) pid1=tailscale-up ;;
              *packages/agent/dist/bin.js*start*) pid1=agent ;;
              *docker-entrypoint.sh*) pid1=entrypoint ;;
            esac
          fi
        done
        [ "\${TS_FORCE_NOISE_443:-}" = "1" ] && force_noise_443=enabled || force_noise_443=disabled
        if grep -q ts_daemon_running_with_ip ./packages/app-core/scripts/docker-entrypoint.sh 2>/dev/null; then
          stuck_cli_escape=present
        else
          stuck_cli_escape=absent
        fi
        printf "pid1=%s\\nagent=%s\\nentrypoint=%s\\ntailscale_up=%s\\nforce_noise_443=%s\\nstuck_cli_escape=%s\\n" \
          "$pid1" "$agent" "$entrypoint" "$tailscale_up" "$force_noise_443" "$stuck_cli_escape"
      '`,
    );
    const image = await observe(
      ssh,
      `docker inspect --format '{{.Config.Image}}' ${id}`,
    );
    const logs = await observe(ssh, `docker logs --tail 400 ${id}`);

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
    const runtimeState = classifyRuntimeProcessState(runtime.output);
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: the protected worker EnvironmentFile owns this deployment value.
    const configuredImage = process.env.ELIZA_AGENT_IMAGE?.trim();
    console.log(
      `MESH_DIAGNOSTIC=${JSON.stringify({
        schemaVersion: 2,
        targetCount: 1,
        container: {
          inspect: inspect.ok ? "success" : "error",
          status: containerStatus,
          exitCode,
          imageMatchesConfigured:
            image.ok && configuredImage
              ? image.output.trim() === configuredImage
              : null,
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
        runtime: runtimeState,
      })}`,
    );
  } finally {
    await ssh.disconnect();
  }
}

if (import.meta.main) {
  try {
    await run(process.argv[2] ?? "");
    await DockerSSHClient.disconnectAll();
    process.exit(0);
  } catch {
    // error-policy:J1 The workflow receives only a non-zero diagnostic status;
    // raw database, SSH, and container failures must stay on the host.
    await DockerSSHClient.disconnectAll();
    process.exit(1);
  }
}
