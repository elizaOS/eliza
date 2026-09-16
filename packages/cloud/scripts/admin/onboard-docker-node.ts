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
 *      agent naming scheme — never an active sandbox or exact-restore candidate),
 *   5. ensure the local-embedding sidecar is running (same contract the
 *      cloud-init bootstrap installs; see `embedding-sidecar.ts`),
 *   6. pre-pull the agent image,
 *   7. attest the exact Linux boot UUID over host-key-verified SSH,
 *   8. upsert the node into `docker_nodes` (update if it already exists),
 *   9. print a clear summary of what changed vs. was already in place.
 *
 * No secrets are hard-coded: the registry token (if any) comes from the
 * control-plane env via `containersEnv`; the DB target from `DATABASE_URL`.
 *
 * Usage:
 *   DATABASE_URL=... bun run packages/cloud/scripts/admin/onboard-docker-node.ts \
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
import {
  parseCanonicalInt,
  parseTcpPort,
} from "../../../scripts/lib/cli-numbers.mjs";

// The cloud-shared modules are imported lazily inside main() (see loadDeps) so
// importing this file for its pure helpers — e.g. from the unit test — does not
// drag in the Drizzle / plugin-sql DB stack.
async function loadDeps() {
  const [
    { dockerNodesRepository, stampDockerNodeEnvironmentMetadata },
    { parseLinuxBootId },
    { ensureRegistryAccess },
    dockerUtils,
    { DockerSSHClient },
    { buildEnsureEmbeddingSidecarCmd },
  ] = await Promise.all([
    import("@elizaos/cloud-shared/db/repositories/docker-nodes"),
    import(
      "@elizaos/cloud-shared/db/repositories/agent-backup-source-authority"
    ),
    import(
      "@elizaos/cloud-shared/lib/services/containers/hetzner-client/registry"
    ),
    import("@elizaos/cloud-shared/lib/services/docker-sandbox-utils"),
    import("@elizaos/cloud-shared/lib/services/docker-ssh"),
    import("@elizaos/cloud-shared/lib/services/containers/embedding-sidecar"),
  ]);
  return {
    dockerNodesRepository,
    stampDockerNodeEnvironmentMetadata,
    parseLinuxBootId,
    ensureRegistryAccess,
    buildEnsureNetworkCmd: dockerUtils.buildEnsureNetworkCmd,
    shellQuote: dockerUtils.shellQuote,
    DockerSSHClient,
    buildEnsureEmbeddingSidecarCmd,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in onboard-docker-node.test.ts)
// ---------------------------------------------------------------------------

/** Container-name prefixes the cloud control plane uses for agent workloads. */
export const AGENT_CONTAINER_PREFIXES = ["agent-", "cloud-container-"] as const;

/** Docker states that mean a container is NOT actively serving — safe to reap. */
const REAPABLE_STATES = ["exited", "created", "dead"] as const;

// Exact restore candidates are deliberately created stopped and remain so
// until the restore coordinator adopts them. Re-onboarding must not interpret
// that quarantine state as zombie evidence. Keep the lexical UUID shape broad
// enough for every canonical UUID version accepted by PostgreSQL and future
// restore authorities; preserving an exact-name candidate is fail-closed.
const CANONICAL_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXACT_RESTORE_CONTAINER_NAME = new RegExp(
  `^agent-restore-${CANONICAL_UUID}-${CANONICAL_UUID}$`,
);

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
 * Conservative zombie filter: an ordinary agent-named container in a
 * non-running state. Running / restarting / paused containers and stopped
 * exact-restore candidates are NEVER selected, so an active or quarantined
 * sandbox is never touched even if its DB row drifted.
 */
export function selectZombieAgentContainers(rows: DockerPsRow[]): string[] {
  return rows
    .filter(
      (row) =>
        AGENT_CONTAINER_PREFIXES.some((prefix) =>
          row.name.startsWith(prefix),
        ) &&
        !EXACT_RESTORE_CONTAINER_NAME.test(row.name) &&
        (REAPABLE_STATES as readonly string[]).includes(row.state),
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

interface ExistingDockerNodePin {
  host_key_fingerprint: string | null;
  capacity: number;
}

interface ExistingDockerNodeSourceAuthority {
  fleet_kind: "robot" | "cloud" | null;
  infrastructure_provider: "hetzner" | null;
  provider_server_id: string | null;
}

interface OnboardSshConfig {
  hostname: string;
  port: number;
  username: string;
  privateKeyPath: string;
  hostKeyFingerprint?: string;
  onHostKeyDiscovered: (hostname: string, fingerprint: string) => Promise<void>;
}

export function buildOnboardSshConfig(
  args: OnboardArgs,
  existing: ExistingDockerNodePin | null,
  onHostKeyDiscovered: OnboardSshConfig["onHostKeyDiscovered"],
): OnboardSshConfig {
  return {
    hostname: args.host,
    port: args.sshPort,
    username: args.sshUser,
    privateKeyPath: args.keyPath,
    hostKeyFingerprint: existing?.host_key_fingerprint ?? undefined,
    onHostKeyDiscovered,
  };
}

export function hostKeyFingerprintForOnboardUpsert(
  existing: ExistingDockerNodePin | null,
  capturedFingerprint: string | undefined,
): string | null {
  return existing?.host_key_fingerprint ?? capturedFingerprint ?? null;
}

export function assertRobotOnboardAuthorityCompatible(
  existing: ExistingDockerNodeSourceAuthority | null,
): void {
  if (!existing) return;
  const isUnclassifiedLegacy =
    existing.fleet_kind === null &&
    existing.infrastructure_provider === null &&
    existing.provider_server_id === null;
  const isExactRobot =
    existing.fleet_kind === "robot" &&
    existing.infrastructure_provider === "hetzner" &&
    existing.provider_server_id === null;
  if (!isUnclassifiedLegacy && !isExactRobot) {
    throw new Error(
      "Refusing to reinterpret an ambiguous or typed Cloud node as Robot authority",
    );
  }
}

export function requireOnboardHostKeyFingerprint(
  existing: ExistingDockerNodePin | null,
  capturedFingerprint: string | undefined,
): string {
  const fingerprint = hostKeyFingerprintForOnboardUpsert(
    existing,
    capturedFingerprint,
  );
  if (!fingerprint?.trim()) {
    throw new Error(
      "Robot source authority requires an SSH host-key fingerprint",
    );
  }
  return fingerprint.trim();
}

/**
 * Capacity to write on (re-)onboard. Once a node exists, its slot count is
 * operator-owned (tuned via the admin PATCH route or a direct DB update to
 * match the box's real RAM), so a re-onboard preserves it and never resets it
 * to the `--capacity` default (which is sized for the small cpx32-class node
 * this script was born on). The flag value is only used to seed a brand-new
 * row.
 */
export function capacityForOnboardUpsert(
  existing: ExistingDockerNodePin | null,
  flagCapacity: number,
): number {
  return existing?.capacity ?? flagCapacity;
}

/**
 * Parse argv + env into a validated config. Throws on missing required
 * fields or a non-canonical ssh-port / capacity token (scientific notation,
 * hex, leading zeros, trailing junk) so Number.parseInt cannot silently
 * retarget the host or shrink the slot count.
 */
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
  // parseInt("1e4")===1 is still a legal TCP port; require the same
  // canonical decimal the rest of the repo uses for CLI ports/limits.
  const sshPort = parseTcpPort(
    flags.get("ssh-port") ?? env.ONBOARD_NODE_SSH_PORT ?? "22",
    "--ssh-port",
  ) as number;
  const sshUser = flags.get("ssh-user") ?? env.ONBOARD_NODE_SSH_USER ?? "root";
  const capacityRaw = flags.get("capacity") ?? env.ONBOARD_NODE_CAPACITY ?? "8";
  const capacity = parseCanonicalInt(capacityRaw, "--capacity", {
    min: 1,
    max: 64,
  }) as number;

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
    stampDockerNodeEnvironmentMetadata,
    parseLinuxBootId,
    ensureRegistryAccess,
    buildEnsureNetworkCmd,
    shellQuote,
    DockerSSHClient,
    buildEnsureEmbeddingSidecarCmd,
  } = await loadDeps();
  const summary: string[] = [];
  const existing = await dockerNodesRepository.findByNodeId(args.nodeId);
  assertRobotOnboardAuthorityCompatible(existing);

  // Re-onboard must verify against the stored pin before any root SSH command
  // runs. Only a never-pinned node takes the TOFU branch and persists the
  // captured key during the upsert below.
  let capturedFingerprint: string | undefined;
  const ssh = new DockerSSHClient(
    buildOnboardSshConfig(args, existing, async (hostname, fingerprint) => {
      capturedFingerprint = fingerprint;
      console.log(
        `[onboard] TOFU captured host key for ${hostname}: SHA256:${fingerprint}`,
      );
    }),
  );

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

    // 5. Ensure the local-embedding sidecar is running. Non-fatal on failure —
    // the node still registers and the control plane's health loop both
    // surfaces the missing sidecar (docker_nodes metadata) and self-heals it,
    // so a transient pull failure here cannot silently strand the node on the
    // cloud embedding path forever.
    await ssh
      .exec(buildEnsureEmbeddingSidecarCmd(), 10 * 60 * 1000)
      .then(() => summary.push("embedding sidecar ensured"))
      .catch((err) => {
        console.warn(
          `[onboard] embedding sidecar install failed (health loop will surface + self-heal): ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.push(
          "embedding sidecar install FAILED (health loop will self-heal)",
        );
      });

    // 6. Pull the agent image now so the first deploy on this node is warm.
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

    // 7. Read the exact running-kernel identity over the same verified SSH
    // connection. Unlike image warming, this proof is mandatory: without it
    // the node must not become manifest-v2 source authority.
    const nodeIncarnation = parseLinuxBootId(
      await ssh.exec("cat /proc/sys/kernel/random/boot_id", 30_000),
    );
    const hostKeyFingerprint = requireOnboardHostKeyFingerprint(
      existing,
      capturedFingerprint,
    );
    summary.push(`boot incarnation attested (${nodeIncarnation})`);

    // 8. Register / upsert exact Robot authority. Existing rows use one CAS
    // write so reboot rotation and operational host updates cannot tear apart.
    if (existing) {
      await dockerNodesRepository.attestRobotSourceAuthority({
        id: existing.id,
        nodeId: args.nodeId,
        expectedIncarnation: existing.node_incarnation,
        expectedHostKeyFingerprint: existing.host_key_fingerprint,
        observedIncarnation: nodeIncarnation,
        registration: {
          hostname: args.host,
          sshPort: args.sshPort,
          sshUser: args.sshUser,
          // Preserve an operator-tuned capacity across re-onboards; the
          // `--capacity` default only seeds a brand-new row.
          capacity: capacityForOnboardUpsert(existing, args.capacity),
          status: "unknown",
          hostKeyFingerprint,
          metadata: stampDockerNodeEnvironmentMetadata({
            ...((existing.metadata as Record<string, unknown>) ?? {}),
            provider: "operator-onboarded",
            lastOnboardedAt: new Date().toISOString(),
          }),
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
        host_key_fingerprint: hostKeyFingerprint,
        fleet_kind: "robot",
        infrastructure_provider: "hetzner",
        provider_server_id: null,
        node_incarnation: nodeIncarnation,
        metadata: stampDockerNodeEnvironmentMetadata({
          provider: "operator-onboarded",
          onboardedAt: new Date().toISOString(),
        }),
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
