#!/usr/bin/env bun
/**
 * One-off Docker-disk prune for a single agent node — the immediate staging
 * unblock for a node that is OUT OF DISK (`no space left on device` while
 * pulling the agent image, breaking dedicated-agent provisioning on it).
 *
 * It runs the SAME reclamation the provisioning-worker daemon's disk-cleanup
 * cycle runs (`docker system prune -af` WITHOUT `--volumes` + clear stuck
 * containerd ingest from failed pulls + buildkit prune), over the SAME node-exec
 * primitive (`DockerSSHClient`), reading the daemon's configured env — so it
 * authenticates with `CONTAINERS_SSH_KEY` exactly like the daemon and never
 * touches key material itself. Prints `df` before and after; prints NO secrets.
 *
 * The recurring daemon cycle PREVENTS recurrence; this script UNBLOCKS NOW.
 *
 * ── Invocation on the staging CP ──────────────────────────────────────────────
 * The daemon runs on the control-plane host with its env at
 * `/opt/eliza/cloud/.env.local`. SSH in as the deploy user and run with bun from
 * the deployed `/opt/eliza` layout. The admin scripts are imported into that
 * layout, where the cloud-shared package resolves as `@elizaos/cloud-shared/...`
 * (NOT a relative `packages/cloud/shared/...` path — that only resolves in the
 * monorepo checkout). This script already imports via `@elizaos/cloud-shared/*`
 * so it resolves in both, but keep that in mind if you adapt it.
 *
 *   ssh deploy@<staging-cp>            # 167.233.105.184 (see infra access map)
 *   cd /opt/eliza/cloud
 *   set -a; . ./.env.local; set +a     # load CONTAINERS_SSH_KEY etc. (no echo)
 *   bun /opt/eliza/.../packages/scripts/cloud/admin/prune-node-disk.ts \
 *     --node-id eliza-core-95ea703e
 *
 * You can target by node-id (looked up in docker_nodes for hostname/port/user) or
 * pass --host directly to skip the DB lookup:
 *
 *   bun .../prune-node-disk.ts --host 10.0.0.7 --ssh-user root
 *
 * Flags (env fallback in parens):
 *   --node-id  <id>            docker_nodes node_id to resolve (PRUNE_NODE_ID)
 *   --host     <ip|hostname>   SSH target, skips the DB lookup (PRUNE_NODE_HOST)
 *   --ssh-port <n>             SSH port (PRUNE_NODE_SSH_PORT)        [default 22]
 *   --ssh-user <user>          SSH user (PRUNE_NODE_SSH_USER)        [default root]
 *   --dry-run                  Print df + the planned reclamation, reclaim nothing.
 *
 * Exactly one of --node-id / --host is required.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

async function loadDeps() {
  const [{ dockerNodesRepository }, { DockerSSHClient }, diskMgr] =
    await Promise.all([
      import("@elizaos/cloud-shared/db/repositories/docker-nodes"),
      import("@elizaos/cloud-shared/lib/services/docker-ssh"),
      import("@elizaos/cloud-shared/lib/services/node-disk-manager"),
    ]);
  return {
    dockerNodesRepository,
    DockerSSHClient,
    buildReclaimCommand: diskMgr.buildReclaimCommand,
    parseDfUsedPercent: diskMgr.parseDfUsedPercent,
  };
}

// ---------------------------------------------------------------------------
// Pure arg parsing (testable without the DB/SSH stack)
// ---------------------------------------------------------------------------

export interface PruneArgs {
  nodeId?: string;
  host?: string;
  sshPort: number;
  sshUser: string;
  dryRun: boolean;
}

export function parsePruneArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): PruneArgs {
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

  const nodeId = flags.get("node-id") ?? env.PRUNE_NODE_ID;
  const host = flags.get("host") ?? env.PRUNE_NODE_HOST;
  if (!nodeId && !host) {
    throw new Error(
      "Provide exactly one of --node-id (resolved via docker_nodes) or --host",
    );
  }
  if (nodeId && host) {
    throw new Error("Provide only ONE of --node-id or --host, not both");
  }

  const sshPort = Number.parseInt(
    flags.get("ssh-port") ?? env.PRUNE_NODE_SSH_PORT ?? "22",
    10,
  );
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new Error(`Invalid ssh-port: ${flags.get("ssh-port")}`);
  }
  const sshUser = flags.get("ssh-user") ?? env.PRUNE_NODE_SSH_USER ?? "root";

  return {
    ...(nodeId ? { nodeId } : {}),
    ...(host ? { host } : {}),
    sshPort,
    sshUser,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DF_TIMEOUT_MS = 15_000;
const RECLAIM_TIMEOUT_MS = 5 * 60_000;
const DF_CMD = "df -P /var/lib/docker 2>/dev/null || df -P /";

async function main(): Promise<void> {
  const args = parsePruneArgs(process.argv.slice(2), process.env);
  const {
    dockerNodesRepository,
    DockerSSHClient,
    buildReclaimCommand,
    parseDfUsedPercent,
  } = await loadDeps();

  // Resolve SSH target: explicit --host, or the docker_nodes row for --node-id.
  let host = args.host;
  let sshPort = args.sshPort;
  let sshUser = args.sshUser;
  let fingerprint: string | undefined;

  if (args.nodeId) {
    const node = await dockerNodesRepository.findByNodeId(args.nodeId);
    if (!node) {
      throw new Error(`No docker_nodes row for node-id "${args.nodeId}"`);
    }
    host = node.hostname;
    sshPort = node.ssh_port ?? 22;
    sshUser = node.ssh_user ?? "root";
    fingerprint = node.host_key_fingerprint ?? undefined;
    console.log(
      `[prune-node-disk] resolved node "${args.nodeId}" -> ${sshUser}@${host}:${sshPort}`,
    );
  } else {
    console.log(`[prune-node-disk] target ${sshUser}@${host}:${sshPort}`);
  }

  if (!host) throw new Error("No SSH host resolved");

  const ssh = DockerSSHClient.getClient(host, sshPort, fingerprint, sshUser);
  try {
    await ssh.connect();

    const before = await ssh.exec(DF_CMD, DF_TIMEOUT_MS);
    console.log("\n[prune-node-disk] df BEFORE:");
    console.log(before.trimEnd());
    const beforePct = parseDfUsedPercent(before);

    if (args.dryRun) {
      console.log("\n[prune-node-disk] --dry-run: would run reclamation:");
      console.log(`  ${buildReclaimCommand()}`);
      console.log("[prune-node-disk] --dry-run: no changes made.");
      return;
    }

    console.log(
      "\n[prune-node-disk] reclaiming (prune + clear stuck ingest)...",
    );
    await ssh.exec(buildReclaimCommand(), RECLAIM_TIMEOUT_MS);

    const after = await ssh.exec(DF_CMD, DF_TIMEOUT_MS);
    console.log("\n[prune-node-disk] df AFTER:");
    console.log(after.trimEnd());
    const afterPct = parseDfUsedPercent(after);

    if (beforePct !== null && afterPct !== null) {
      console.log(
        `\n[prune-node-disk] done: ${beforePct}% -> ${afterPct}% (reclaimed ${
          beforePct - afterPct
        } points)`,
      );
    } else {
      console.log("\n[prune-node-disk] done (could not parse df percent).");
    }
  } finally {
    await ssh.disconnect().catch(() => {});
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  // Load the daemon's env the same way the daemons do, so CONTAINERS_SSH_KEY and
  // DATABASE_URL resolve from /opt/eliza/cloud/.env.local without re-export.
  //
  // `loadLocalEnv` resolves the project root as ../../.. from the dir of the URL
  // it's given. The daemons live in `.../scripts/cloud/admin/daemons/<f>.ts` and
  // resolve to `packages/scripts` (where the deployed `.env.local` is loaded
  // from). This script lives one dir up (`.../scripts/cloud/admin/`), so handing
  // load-env `import.meta.url` directly would resolve to `packages/` — one level
  // too high. Point it at a real file INSIDE the daemons dir so the project-root
  // resolution is byte-for-byte the same as the daemon's.
  import("./daemons/shared/load-env")
    .then(({ loadLocalEnv }) => {
      loadLocalEnv(
        new URL("./daemons/provisioning-worker.ts", import.meta.url).href,
      );
    })
    .catch(() => {
      // load-env is best-effort: if the layout differs, env may already be set
      // by `set -a; . ./.env.local` per the header invocation.
    })
    .finally(() => {
      main().catch((error) => {
        console.error(
          "[prune-node-disk] failed:",
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      });
    });
}
