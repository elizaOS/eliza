#!/usr/bin/env bun
/**
 * Onboard an EXISTING host (e.g. a Hetzner robot box) as an elizaOS Cloud
 * Docker node — with zero manual SSH/DB steps.
 *
 * A robot/auctioned host can't be cloud-init'd (it's already running), so this
 * script runs the bootstrap-equivalent steps over SSH and then registers the
 * node into `docker_nodes` the same way the autoscaler / bootstrap-callback do.
 * It is the operator-side counterpart to `buildContainerNodeUserData`.
 *
 * Every step is idempotent and safe to re-run:
 *   1. verify/install Docker + ensure the daemon is running,
 *   2. ensure the shared bridge network exists,
 *   3. ensure deterministic ghcr access — THE robot fix: clear any stale
 *      stored credential (an expired ghcr token in /root/.docker/config.json
 *      overrides anonymous access and bricks the public-image pull with
 *      `denied`). Reuses `ensureRegistryAccess`.
 *   4. clean zombie/stale agent containers (exited/created orphans matching the
 *      agent naming scheme — never an active sandbox),
 *   5. upsert the node into `docker_nodes` (update if it already exists),
 *   6. print a clear summary of what changed vs. was already in place.
 *
 * No secrets are hard-coded: the registry token (if any) comes from the
 * control-plane env via `containersEnv`; the DB target from `DATABASE_URL`.
 *
 * Usage:
 *   DATABASE_URL=... bun run packages/scripts/cloud/admin/onboard-docker-node.ts \
 *     --host 1.2.3.4 --key ~/.ssh/id_ed25519_eliza --node-id robot-fsn1-01
 *
 * Flags (env fallback in parens):
 *   --host        <ip|hostname>  SSH target (ONBOARD_NODE_HOST)              [required]
 *   --node-id     <id>           Logical node id (ONBOARD_NODE_ID)          [required]
 *   --key         <path>         SSH private key path (ONBOARD_NODE_SSH_KEY) [default ~/.ssh/id_ed25519]
 *   --ssh-port    <n>            SSH port (ONBOARD_NODE_SSH_PORT)            [default 22]
 *   --ssh-user    <user>         SSH user (ONBOARD_NODE_SSH_USER)           [default root]
 *   --capacity    <n>            Agent capacity (ONBOARD_NODE_CAPACITY)     [default 8]
 *   --dry-run                    Print the planned steps, touch nothing.
 */

import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The cloud-shared modules are imported lazily inside main() (see loadDeps) so
// importing this file for its pure helpers — e.g. from the unit test — does not
// drag in the Drizzle / plugin-sql DB stack.
async function loadDeps() {
  const [
    { dockerNodesRepository },
    { ensureRegistryAccess },
    dockerUtils,
    { DockerSSHClient },
  ] = await Promise.all([
    import("@elizaos/cloud-shared/db/repositories/docker-nodes"),
    import(
      "@elizaos/cloud-shared/lib/services/containers/hetzner-client/registry"
    ),
    import("@elizaos/cloud-shared/lib/services/docker-sandbox-utils"),
    import("@elizaos/cloud-shared/lib/services/docker-ssh"),
  ]);
  return {
    dockerNodesRepository,
    ensureRegistryAccess,
    buildEnsureNetworkCmd: dockerUtils.buildEnsureNetworkCmd,
    shellQuote: dockerUtils.shellQuote,
    DockerSSHClient,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in onboard-docker-node.test.ts)
// ---------------------------------------------------------------------------

/** Container-name prefixes the cloud control plane uses for agent workloads. */
export const AGENT_CONTAINER_PREFIXES = ["agent-", "cloud-container-"] as const;

/** Docker states that mean a container is NOT actively serving — safe to reap. */
const REAPABLE_STATES = ["exited", "created", "dead"] as const;

export interface DockerPsRow {
  name: string;
  state: string;
}

/**
 * Parse the output of `docker ps -a --format '{{.Names}}\t{{.State}}'`.
 * Tolerant of blank lines and trailing whitespace.
 */
export function parseDockerPs(output: string): DockerPsRow[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[stderr]"))
    .map((line) => {
      const [name, state] = line.split("\t");
      return {
        name: (name ?? "").trim(),
        state: (state ?? "").trim().toLowerCase(),
      };
    })
    .filter((row) => row.name.length > 0);
}

/**
 * Conservative zombie filter: an agent-named container in a non-running state.
 * Running / restarting / paused containers are NEVER selected, so an active
 * sandbox is never touched even if its DB row drifted.
 */
export function selectZombieAgentContainers(rows: DockerPsRow[]): string[] {
  return rows
    .filter(
      (row) =>
        AGENT_CONTAINER_PREFIXES.some((prefix) =>
          row.name.startsWith(prefix),
        ) && (REAPABLE_STATES as readonly string[]).includes(row.state),
    )
    .map((row) => row.name);
}

export interface OnboardArgs {
  host: string;
  nodeId: string;
  keyPath: string;
  sshPort: number;
  sshUser: string;
  capacity: number;
  dryRun: boolean;
}

/** Parse argv + env into a validated config. Throws on missing required fields. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): OnboardArgs {
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag --${key} requires a value`);
      }
      flags.set(key, value);
      i++;
    }
  }

  const host = flags.get("host") ?? env.ONBOARD_NODE_HOST;
  const nodeId = flags.get("node-id") ?? env.ONBOARD_NODE_ID;
  if (!host) throw new Error("Missing --host (or ONBOARD_NODE_HOST)");
  if (!nodeId) throw new Error("Missing --node-id (or ONBOARD_NODE_ID)");

  const keyPath =
    flags.get("key") ??
    env.ONBOARD_NODE_SSH_KEY ??
    path.join(os.homedir(), ".ssh", "id_ed25519");
  const sshPort = Number.parseInt(
    flags.get("ssh-port") ?? env.ONBOARD_NODE_SSH_PORT ?? "22",
    10,
  );
  const sshUser = flags.get("ssh-user") ?? env.ONBOARD_NODE_SSH_USER ?? "root";
  const capacityRaw = flags.get("capacity") ?? env.ONBOARD_NODE_CAPACITY ?? "8";
  const capacity = Number.parseInt(capacityRaw, 10);

  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new Error(
      `Invalid ssh-port: ${flags.get("ssh-port") ?? env.ONBOARD_NODE_SSH_PORT}`,
    );
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
    throw new Error(`Invalid capacity (must be 1..64): ${capacityRaw}`);
  }

  return { host, nodeId, keyPath, sshPort, sshUser, capacity, dryRun };
}

// ---------------------------------------------------------------------------
// Onboarding flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);

  // Resolve network/image from config for the preview. `containersEnv` is a
  // light import; the heavier DB/SSH stack is only loaded once we commit to
  // touching the host, so --dry-run stays side-effect-free.
  const { containersEnv } = await import(
    "@elizaos/cloud-shared/lib/config/containers-env"
  );
  const network = containersEnv.dockerNetwork();
  const image = containersEnv.defaultAgentImage();

  console.log(
    `[onboard] target ${args.sshUser}@${args.host}:${args.sshPort} as node "${args.nodeId}"`,
  );
  console.log(
    `[onboard] network=${network} image=${image} capacity=${args.capacity}`,
  );
  if (args.dryRun) {
    console.log("[onboard] --dry-run: no changes will be made.");
    return;
  }

  const {
    dockerNodesRepository,
    ensureRegistryAccess,
    buildEnsureNetworkCmd,
    shellQuote,
    DockerSSHClient,
  } = await loadDeps();
  const summary: string[] = [];

  const ssh = new DockerSSHClient({
    hostname: args.host,
    port: args.sshPort,
    username: args.sshUser,
    privateKeyPath: args.keyPath,
  });

  try {
    // 1. Docker present + running (install via get.docker.com only if missing).
    const hasDocker = await ssh
      .exec("command -v docker >/dev/null 2>&1 && echo yes || echo no", 30_000)
      .then((out) => out.includes("yes"));
    if (!hasDocker) {
      console.log("[onboard] docker not found — installing via get.docker.com");
      await ssh.exec("curl -fsSL https://get.docker.com | sh", 5 * 60 * 1000);
      summary.push("installed Docker");
    } else {
      summary.push("Docker already present");
    }
    await ssh.exec(
      "systemctl enable --now docker >/dev/null 2>&1 || true",
      60_000,
    );
    await ssh.exec("docker info >/dev/null 2>&1", 30_000);
    summary.push("Docker daemon running");

    // 2. Shared bridge network (idempotent, race-safe).
    await ssh.exec(buildEnsureNetworkCmd(network), 30_000);
    summary.push(`network "${network}" ensured`);

    // 3. THE robot fix: deterministic registry access (clear stale ghcr cred).
    await ensureRegistryAccess(ssh, image);
    summary.push(
      containersEnv.registryToken() || containersEnv.registryTokenFile()
        ? "ghcr login refreshed (token configured)"
        : "ghcr stale creds cleared (anonymous pull)",
    );

    // 4. Reap zombie agent containers (orphaned, non-running). Conservative.
    const psOutput = await ssh.exec(
      "docker ps -a --format '{{.Names}}\t{{.State}}'",
      30_000,
    );
    const zombies = selectZombieAgentContainers(parseDockerPs(psOutput));
    if (zombies.length > 0) {
      await ssh.exec(
        `docker rm -f ${zombies.map(shellQuote).join(" ")}`,
        60_000,
      );
      summary.push(
        `removed ${zombies.length} zombie container(s): ${zombies.join(", ")}`,
      );
    } else {
      summary.push("no zombie containers");
    }

    // 5. Pull the agent image now so the first deploy on this node is warm.
    console.log(
      `[onboard] pre-pulling ${image} (first run can take a few minutes)`,
    );
    await ssh
      .exec(`docker pull ${shellQuote(image)}`, 10 * 60 * 1000)
      .then(() => summary.push("agent image pulled"))
      .catch((err) => {
        console.warn(
          `[onboard] image pre-pull failed (node still registers; will retry on deploy): ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.push("agent image pre-pull FAILED (non-fatal)");
      });

    // 6. Register / upsert into docker_nodes — same shape as bootstrap-callback.
    const existing = await dockerNodesRepository.findByNodeId(args.nodeId);
    if (existing) {
      await dockerNodesRepository.update(existing.id, {
        hostname: args.host,
        ssh_port: args.sshPort,
        ssh_user: args.sshUser,
        capacity: args.capacity,
        status: "unknown",
        metadata: {
          ...((existing.metadata as Record<string, unknown>) ?? {}),
          provider: "operator-onboarded",
          lastOnboardedAt: new Date().toISOString(),
        },
      });
      summary.push(`docker_nodes row updated (${args.nodeId})`);
    } else {
      await dockerNodesRepository.create({
        node_id: args.nodeId,
        hostname: args.host,
        ssh_port: args.sshPort,
        ssh_user: args.sshUser,
        capacity: args.capacity,
        enabled: true,
        status: "unknown",
        allocated_count: 0,
        metadata: {
          provider: "operator-onboarded",
          onboardedAt: new Date().toISOString(),
        },
      });
      summary.push(`docker_nodes row created (${args.nodeId})`);
    }
  } finally {
    // error-policy:J6 best-effort SSH teardown; the onboarding result already stands
    await ssh.disconnect().catch(() => {});
  }

  console.log("\n[onboard] done:");
  for (const line of summary) console.log(`  - ${line}`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(
      "[onboard] failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
