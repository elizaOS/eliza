/**
 * Exercises the real Docker provider's disabled-first restore branch with a
 * scripted SSH boundary, including pre-effect intent ordering and the absence
 * of discovery, boot, routing publication, and image re-resolution.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import * as nodeAutoscaler from "../containers/node-autoscaler";
import * as registryProbe from "../containers/registry-probe";
import { dockerNodeManager } from "../docker-node-manager";
import * as dockerPortAllocation from "../docker-port-allocation";
import {
  buildExactRestoreBootFencedCommand,
  buildExactRestoreDockerBootFencedCommand,
  DockerSandboxProvider,
} from "../docker-sandbox-provider";
import * as dockerSandboxUtils from "../docker-sandbox-utils";
import { DockerSSHClient } from "../docker-ssh";
import { headscaleIntegration } from "../headscale-integration";
import type { SandboxCreateConfig, SandboxHandle } from "../sandbox-provider-types";
import {
  SandboxReplacementCleanupUnresolvedError,
  SandboxReplacementCreateSettlementCleanupUnresolvedError,
} from "../sandbox-provider-types";
import * as stewardTenantConfig from "../steward-tenant-config";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const RESTORE_ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const NODE_RECORD_ID = "55555555-5555-4555-8555-555555555555";
const NODE_INCARNATION = "66666666-6666-4666-8666-666666666666";
const NODE_HISTORY_ID = "77777777-7777-4777-8777-777777777777";
const CONTAINER_ID = "a".repeat(64);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE_PLATFORM_DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE_CONFIG_DIGEST = `sha256:${"d".repeat(64)}`;
const IMAGE_REFERENCE = `ghcr.io/elizaos/eliza@${IMAGE_DIGEST}`;
const IMAGE_PLATFORM_REFERENCE = `ghcr.io/elizaos/eliza@${IMAGE_PLATFORM_DIGEST}`;
const CONTAINER_NAME = `agent-restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`;
const VOLUME_PATH = `/data/agents/.restore/${AGENT_ID}/${RESTORE_ATTEMPT_ID}`;

const NODE: DockerNode = {
  id: NODE_RECORD_ID,
  node_id: "restore-node-a",
  hostname: "192.0.2.44",
  ssh_port: 22,
  capacity: 8,
  enabled: true,
  placement_state: "open",
  status: "healthy",
  allocated_count: 8,
  last_health_check: null,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:restore-node",
  fleet_kind: "robot",
  infrastructure_provider: "hetzner",
  provider_server_id: null,
  node_incarnation: NODE_INCARNATION,
  current_node_history_id: NODE_HISTORY_ID,
  backup_admission_xid: "1",
  metadata: { environment: "local", architecture: "amd64" },
  created_at: new Date("2026-08-29T00:00:00.000Z"),
  updated_at: new Date("2026-08-29T00:00:00.000Z"),
};

function exactRestoreConfig(overrides: Partial<SandboxCreateConfig> = {}): SandboxCreateConfig {
  return {
    agentId: AGENT_ID,
    agentName: "Restore candidate",
    organizationId: ORGANIZATION_ID,
    executionTier: "dedicated-always",
    environmentVars: {},
    replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
    exactRestore: {
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      target: {
        nodeRecordId: NODE_RECORD_ID,
        nodeId: NODE.node_id,
        nodeIncarnation: NODE_INCARNATION,
        nodeHistoryId: NODE_HISTORY_ID,
        platform: "linux/amd64",
      },
      imageReference: IMAGE_REFERENCE,
      imageDigest: IMAGE_DIGEST,
      imagePlatformDigest: IMAGE_PLATFORM_DIGEST,
      quarantine: true,
    },
    onReplacementCreateAttemptStarted: async () => {},
    onReplacementCreateIntent: async () => {},
    onReplacementCreated: async () => {},
    onReplacementCreateSettled: async () => {},
    ...overrides,
  };
}

function installExactRestoreSsh(
  options: {
    containerRunning?: boolean;
    createFailure?: Error;
    dockerClientApiVersion?: string;
    dockerDriverStatus?: unknown;
    dockerServerApiVersion?: string;
    imagePlatform?: "linux/amd64" | "linux/arm64";
    manifestDigest?: string;
    manifestPlatform?: "linux/amd64" | "linux/arm64";
    repoDigests?: string[];
  } = {},
): {
  commands: string[];
  stdinCommands: string[];
  ssh: DockerSSHClient;
} {
  const commands: string[] = [];
  const stdinCommands: string[] = [];
  const imagePlatform = options.imagePlatform ?? "linux/amd64";
  const manifestDigest = options.manifestDigest ?? IMAGE_PLATFORM_DIGEST;
  const manifestPlatform = options.manifestPlatform ?? imagePlatform;
  const repoDigests = options.repoDigests ?? [IMAGE_PLATFORM_REFERENCE];
  const ssh = {
    exec: mock(async (command: string) => {
      commands.push(command);
      if (command.includes("docker version --format")) {
        return `${options.dockerClientApiVersion ?? "1.51"}|${options.dockerServerApiVersion ?? "1.51"}\n${JSON.stringify(
          options.dockerDriverStatus ?? [["driver-type", "io.containerd.snapshotter.v1"]],
        )}\n`;
      }
      if (command.includes("docker image inspect --format")) {
        return `${IMAGE_CONFIG_DIGEST}|${imagePlatform}|${JSON.stringify(repoDigests)}\n`;
      }
      if (command.includes("docker inspect --format")) {
        return `${CONTAINER_ID}|/${CONTAINER_NAME}|${options.containerRunning ?? false}|created|none|no|{}|${IMAGE_PLATFORM_REFERENCE}|${IMAGE_CONFIG_DIGEST}|linux|${manifestDigest}|${manifestPlatform}\n`;
      }
      if (command.includes('candidate_id=$(cat -- "$attempt_candidate_id")')) {
        return `${CONTAINER_ID}\n`;
      }
      return "";
    }),
    execStdinAbortable: mock(async (command: string) => {
      stdinCommands.push(command);
      if (options.createFailure) throw options.createFailure;
    }),
    disconnect: mock(async () => {}),
  } as DockerSSHClient;
  spyOn(DockerSSHClient, "createDedicated").mockReturnValue(ssh);
  return { commands, stdinCommands, ssh };
}

afterEach(() => {
  mock.restore();
});

describe("DockerSandboxProvider exact restore quarantine", () => {
  test("exports the boot-occurrence fence for the byte-native vault seed", () => {
    const command = buildExactRestoreBootFencedCommand(NODE_INCARNATION, "seed-vault-bytes");

    expect(command).toContain("/proc/sys/kernel/random/boot_id");
    expect(command).toContain(`!= '${NODE_INCARNATION}'`);
    expect(command).toEndWith("; seed-vault-bytes");
  });

  test("rejects a different boot occurrence before executing the exact command", async () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-exact-boot-fence-"));
    const bootId = join(root, "boot-id");
    const marker = join(root, "inner-command-ran");
    try {
      writeFileSync(bootId, "88888888-8888-4888-8888-888888888888\n", { mode: 0o600 });
      const command = buildExactRestoreBootFencedCommand(
        NODE_INCARNATION,
        `touch '${marker}'`,
      ).replace("/proc/sys/kernel/random/boot_id", bootId);
      const child = Bun.spawn(["/bin/sh", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(await child.exited).toBe(78);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pins exact Docker commands to the local daemon despite hostile client environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-exact-docker-host-"));
    const bin = join(root, "bin");
    const bootId = join(root, "boot-id");
    const observed = join(root, "observed");
    try {
      mkdirSync(bin);
      writeFileSync(bootId, `${NODE_INCARNATION}\n`, { mode: 0o600 });
      const fakeDocker = join(bin, "docker");
      writeFileSync(
        fakeDocker,
        '#!/bin/sh\nprintf \'%s|%s|%s|%s\\n\' "$DOCKER_HOST" "${DOCKER_CONTEXT-unset}" "${DOCKER_CONFIG-unset}" "$*" > "$ELIZA_TEST_OBSERVED"\n',
        { mode: 0o700 },
      );
      chmodSync(fakeDocker, 0o700);
      const command = buildExactRestoreDockerBootFencedCommand(
        NODE_INCARNATION,
        "docker inspect exact-candidate",
      )
        .replace("/proc/sys/kernel/random/boot_id", bootId)
        .replaceAll("chmod 700 --", "chmod 700")
        .replaceAll("chmod 600 --", "chmod 600");
      const child = Bun.spawn(["/bin/sh", "-c", command], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          DOCKER_HOST: "tcp://attacker.invalid:2376",
          DOCKER_CONTEXT: "attacker-context",
          DOCKER_CONFIG: join(root, "attacker-config"),
          DOCKER_TLS_VERIFY: "1",
          DOCKER_CERT_PATH: join(root, "attacker-certs"),
          ELIZA_TEST_OBSERVED: observed,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      const [dockerHost, dockerContext, dockerConfig, dockerArguments] = readFileSync(
        observed,
        "utf8",
      )
        .trim()
        .split("|");
      expect(dockerHost).toBe("unix:///var/run/docker.sock");
      expect(dockerContext).toBe("unset");
      expect(dockerConfig).toStartWith("/tmp/eliza-exact-docker.");
      expect(dockerArguments).toBe(
        `--host unix:///var/run/docker.sock --config ${dockerConfig} inspect exact-candidate`,
      );
      expect(existsSync(dockerConfig!)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("advertises the disabled-first exact restore capability", () => {
    expect(new DockerSandboxProvider().exactRestoreCreateCapability).toBe("stopped-quarantine-v1");
  });

  test("awaits durable intent before SSH, volume, registry, or Docker effects", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const hostPortRead = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const ssh = spyOn(DockerSSHClient, "createDedicated");
    const intentFailure = new Error("durable intent verifier rejected");
    const intent = mock(async () => {
      throw intentFailure;
    });

    const error = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ onReplacementCreateIntent: intent }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(intentFailure);
    expect(intent).toHaveBeenCalledTimes(1);
    expect(hostPortRead).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("fails closed before SSH when only legacy argv registry auth is configured", async () => {
    const savedRegistryToken = process.env.CONTAINERS_REGISTRY_TOKEN;
    process.env.CONTAINERS_REGISTRY_TOKEN = "must-never-enter-an-ssh-command";
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const intent = mock(async () => {});
    const started = mock(async () => {});
    const ssh = spyOn(DockerSSHClient, "createDedicated");

    let error: unknown;
    try {
      error = await new DockerSandboxProvider()
        .create(
          exactRestoreConfig({
            onReplacementCreateAttemptStarted: started,
            onReplacementCreateIntent: intent,
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      if (savedRegistryToken === undefined) delete process.env.CONTAINERS_REGISTRY_TOKEN;
      else process.env.CONTAINERS_REGISTRY_TOKEN = savedRegistryToken;
    }

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_REGISTRY_CREDENTIAL_TRANSPORT_UNSUPPORTED",
    });
    expect(started).not.toHaveBeenCalled();
    expect(intent).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("creates one exact stopped candidate without discovery, autoscale, routing, or boot", async () => {
    const savedEnvironment = new Map<string, string | undefined>();
    const controlledEnvironment = [
      "ENVIRONMENT",
      "CONTAINERS_REGISTRY_TOKEN",
      "CONTAINERS_REGISTRY_TOKEN_FILE",
      "ELIZA_APP_IMAGE_REGISTRY_TOKEN",
      "ELIZA_APP_IMAGE_REGISTRY_TOKEN_FILE",
      "GHCR_TOKEN",
    ] as const;
    for (const key of controlledEnvironment) savedEnvironment.set(key, process.env[key]);
    process.env.ENVIRONMENT = "local";
    for (const key of controlledEnvironment.filter((key) => key !== "ENVIRONMENT")) {
      delete process.env[key];
    }

    const events: string[] = [];
    const commands: string[] = [];
    const stdinCommands: Array<{ command: string; input: Buffer }> = [];
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockImplementation(
      async () => {
        events.push("target-read");
        return NODE;
      },
    );
    const hostPortRead = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(nodeAutoscaler, "getNodeAutoscaler");
    const fallback = spyOn(dockerNodesRepository, "findAll");
    const increment = spyOn(dockerNodesRepository, "incrementAllocated");
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated");
    const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const imageResolution = spyOn(registryProbe, "resolveImageDigest");
    const vaultSeeder = spyOn(dockerSandboxUtils, "ensureVolumeVaultPassphrase");

    const ssh = {
      exec: mock(async (command: string) => {
        commands.push(command);
        if (command.includes("docker version --format")) {
          events.push("manifest-proof-capability");
          return '1.51|1.51\n[["driver-type","io.containerd.snapshotter.v1"]]\n';
        }
        if (command.includes("stat -c '%a'")) events.push("preseed-proof");
        if (
          command.includes(`docker pull --platform 'linux/amd64' '${IMAGE_PLATFORM_REFERENCE}'`)
        ) {
          events.push("registry");
          events.push("pull");
        }
        if (command.includes("docker inspect --format")) {
          events.push("proof");
          return `${CONTAINER_ID}|/${CONTAINER_NAME}|false|created|none|no|{}|${IMAGE_PLATFORM_REFERENCE}|${IMAGE_CONFIG_DIGEST}|linux|${IMAGE_PLATFORM_DIGEST}|linux/amd64\n`;
        }
        if (command.includes("docker image inspect --format")) {
          events.push("image-proof");
          return `${IMAGE_CONFIG_DIGEST}|linux/amd64|[${JSON.stringify(IMAGE_PLATFORM_REFERENCE)}]\n`;
        }
        if (command.includes('candidate_id=$(cat -- "$attempt_candidate_id")')) {
          return `${CONTAINER_ID}\n`;
        }
        return "";
      }),
      execStdinAbortable: mock(async (command: string, input: Buffer) => {
        stdinCommands.push({ command, input: Buffer.from(input) });
        if (command.includes("docker create")) {
          events.push("docker-create");
          return;
        }
        throw new Error("unexpected exact restore stdin command");
      }),
      disconnect: mock(async () => {}),
    } as DockerSSHClient;
    spyOn(DockerSSHClient, "createDedicated").mockImplementation(() => {
      events.push("ssh-client");
      return ssh;
    });

    const intentHandles: SandboxHandle[] = [];
    const createdHandles: SandboxHandle[] = [];
    let handle: SandboxHandle;
    try {
      handle = await new DockerSandboxProvider().create(
        exactRestoreConfig({
          environmentVars: {
            ELIZA_VAULT_PASSPHRASE: "forbidden-caller-vault-override",
            SANDBOX_REGISTRY_REDIS_URL: "redis://registry.example.test:6379",
            SANDBOX_REGISTRY_REDIS_TOKEN: "forbidden-registry-token",
            SANDBOX_AGENT_ID: "forbidden-agent-id",
            SANDBOX_ROUTE_AGENT_ID: "forbidden-route-id",
            SANDBOX_SERVER_NAME: "forbidden-server-name",
            SANDBOX_PUBLIC_URL: "https://forbidden.example.test",
            AGENT_SERVER_SHARED_SECRET: "forbidden-routing-secret",
            HEADSCALE_API_KEY: "forbidden-headscale-key",
            TS_AUTHKEY: "forbidden-vpn-key",
            STEWARD_AGENT_TOKEN: "forbidden-steward-token",
            ELIZA_CLOUD_PUBLIC_URL: "https://forbidden-public.example.test",
            ORCHESTRATOR_SESSION_ID: "forbidden-orchestrator-session",
            KV_REST_API_URL: "https://forbidden-kv.example.test",
            KV_REST_API_TOKEN: "forbidden-kv-token",
            ALLOWED_RESTORE_SETTING: "present",
          },
          onReplacementCreateAttemptStarted: async () => {
            events.push("started");
          },
          onReplacementCreateIntent: async (candidate) => {
            events.push("intent");
            intentHandles.push(candidate);
          },
          onReplacementCreated: async (candidate) => {
            events.push("created");
            createdHandles.push(candidate);
          },
          onReplacementCreateSettled: async () => {
            events.push("settled");
          },
        }),
      );
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(events.indexOf("started")).toBeLessThan(events.indexOf("intent"));
    expect(events.indexOf("intent")).toBeLessThan(events.indexOf("ssh-client"));
    expect(events.indexOf("ssh-client")).toBeLessThan(events.indexOf("manifest-proof-capability"));
    expect(events.indexOf("manifest-proof-capability")).toBeLessThan(
      events.indexOf("docker-create"),
    );
    expect(events.indexOf("intent")).toBeLessThan(events.indexOf("preseed-proof"));
    expect(events.indexOf("intent")).toBeLessThan(events.indexOf("registry"));
    expect(events.indexOf("intent")).toBeLessThan(events.indexOf("docker-create"));
    expect(events.indexOf("docker-create")).toBeLessThan(events.indexOf("created"));
    expect(events.indexOf("proof")).toBeLessThan(events.indexOf("settled"));
    expect(events.indexOf("image-proof")).toBeLessThan(events.indexOf("settled"));
    expect(events.at(-1)).toBe("settled");

    expect(targetRead).toHaveBeenCalledTimes(3);
    expect(hostPortRead).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(autoscale).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
    expect(decrement).not.toHaveBeenCalled();
    expect(headscale).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(imageResolution).not.toHaveBeenCalled();
    expect(vaultSeeder).not.toHaveBeenCalled();
    expect(stdinCommands).toHaveLength(1);

    const preseedProof = commands.find((command) => command.includes("stat -c '%a'"));
    expect(preseedProof).toContain(`test ! -L '${VOLUME_PATH}'`);
    expect(preseedProof).toContain(`test -f '${VOLUME_PATH}/.vault-passphrase'`);
    expect(preseedProof).toContain("= '600'");
    expect(preseedProof).toContain("= '64'");
    for (const mutatingProofFragment of [
      "mkdir ",
      "install ",
      "touch ",
      "mv ",
      "rm ",
      "truncate ",
      "cat >",
    ]) {
      expect(preseedProof).not.toContain(mutatingProofFragment);
    }

    const dockerCreate = stdinCommands.find(({ command }) => command.includes("docker create"));
    expect(dockerCreate).toBeDefined();
    expect(dockerCreate?.command).toContain(`--name '${CONTAINER_NAME}'`);
    expect(dockerCreate?.command).toContain("--restart no");
    expect(dockerCreate?.command).toContain("--network none");
    expect(dockerCreate?.command).toContain("--no-healthcheck");
    const dockerCreateInvocation = /docker create[^;]+/.exec(dockerCreate?.command ?? "")?.[0];
    expect(dockerCreateInvocation).toBeDefined();
    expect(dockerCreateInvocation).not.toContain(" -p ");
    expect(dockerCreate?.command).toContain(`-v '${VOLUME_PATH}':/app/data`);
    expect(dockerCreate?.command).toContain("--platform 'linux/amd64'");
    expect(dockerCreate?.command).toContain(`'${IMAGE_PLATFORM_REFERENCE}'`);
    expect(dockerCreate?.command).toContain(NODE_INCARNATION);
    expect(dockerCreate?.command).toContain('secure_reset_control_file "$attempt_active"');
    expect(dockerCreate?.command).toContain('test "${#candidate_id}" = 64');
    expect(dockerCreate?.command).toContain('mv -- "$candidate_tmp" "$attempt_candidate_id"');
    const dockerPull = commands.find((command) =>
      command.includes(`docker pull --platform 'linux/amd64' '${IMAGE_PLATFORM_REFERENCE}'`),
    );
    expect(dockerPull).toContain(
      `docker pull --platform 'linux/amd64' '${IMAGE_PLATFORM_REFERENCE}'`,
    );
    expect(dockerPull).toContain(`'${IMAGE_PLATFORM_REFERENCE}'`);
    expect(dockerPull).toContain(`mktemp -d '/tmp/eliza-exact-docker.XXXXXXXXXX'`);
    expect(dockerPull).toContain(`printf '%s\\n' '{"auths":{},"proxies":{}}'`);
    expect(dockerPull).toContain(
      'docker() { command docker --host unix:///var/run/docker.sock --config "$exact_docker_config" "$@"; }',
    );
    expect(dockerPull).not.toContain("docker logout");
    const remoteWire = [
      ...commands,
      ...stdinCommands.flatMap(({ command, input }) => [command, input.toString("utf8")]),
    ].join("\n");
    expect(remoteWire).not.toContain("docker start");
    expect(remoteWire).not.toContain("tailscale");
    expect(remoteWire).not.toContain("headscale");
    expect(remoteWire).not.toContain("curl");
    expect(commands.every((command) => command.includes(NODE_INCARNATION))).toBe(true);
    for (const forbidden of [
      "SANDBOX_REGISTRY_REDIS_URL",
      "SANDBOX_REGISTRY_REDIS_TOKEN",
      "SANDBOX_AGENT_ID",
      "SANDBOX_ROUTE_AGENT_ID",
      "SANDBOX_SERVER_NAME",
      "SANDBOX_PUBLIC_URL",
      "AGENT_SERVER_SHARED_SECRET",
      "KV_REST_API_URL",
      "KV_REST_API_TOKEN",
      "forbidden-registry-token",
      "forbidden-routing-secret",
      "forbidden-caller-vault-override",
      "forbidden-headscale-key",
      "forbidden-vpn-key",
      "forbidden-steward-token",
      "forbidden-orchestrator-session",
      "ELIZA_VAULT_STDIN_V1",
    ]) {
      expect(remoteWire).not.toContain(forbidden);
    }
    expect(remoteWire).toContain("ALLOWED_RESTORE_SETTING=present");

    expect(intentHandles).toHaveLength(1);
    expect(createdHandles).toHaveLength(1);
    expect(intentHandles[0]).toMatchObject({
      sandboxId: CONTAINER_NAME,
      bridgeUrl: "",
      healthUrl: "",
      metadata: {
        nodeRecordId: NODE_RECORD_ID,
        nodeId: NODE.node_id,
        nodeIncarnation: NODE_INCARNATION,
        nodeHistoryId: NODE_HISTORY_ID,
        hostname: NODE.hostname,
        nodeSshPort: NODE.ssh_port,
        nodeSshUser: NODE.ssh_user,
        nodeHostKeyFingerprint: NODE.host_key_fingerprint,
        bridgePort: 0,
        webUiPort: 0,
        volumePath: VOLUME_PATH,
        dockerImage: IMAGE_PLATFORM_REFERENCE,
        imageDigest: IMAGE_DIGEST,
        imageIndexReference: IMAGE_REFERENCE,
        imagePlatformDigest: IMAGE_PLATFORM_DIGEST,
        imagePlatform: "linux/amd64",
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        quarantine: true,
        replacementSecretCleanupVersion: 1,
      },
    });
    expect(intentHandles[0]?.metadata?.containerId).toBeUndefined();
    expect(createdHandles[0]?.metadata?.containerId).toBe(CONTAINER_ID);
    expect(handle).toEqual(createdHandles[0]);
  });

  test("boot-fences exact abandonment and proves the restore staging volume absent", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const pooledSsh = spyOn(DockerSSHClient, "getClient");
    const commands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        commands.push(command);
        if (command.includes("ELIZA_EXACT_RESTORE_STAGING_VOLUME_PURGED_V1")) {
          return dockerSandboxUtils.getExactRestoreStagingVolumeCleanupReceipt(
            REPLACEMENT_ATTEMPT_ID,
            RESTORE_ATTEMPT_ID,
          );
        }
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return `${dockerSandboxUtils.getReplacementSecretArtifactsCleanupReceipt(REPLACEMENT_ATTEMPT_ID)}\n${dockerSandboxUtils.getReplacementDockerCreateQuiescentReceipt(REPLACEMENT_ATTEMPT_ID)}\n`;
        }
        if (command.includes("docker inspect --format")) {
          return `${CONTAINER_ID}|${REPLACEMENT_ATTEMPT_ID}|/${CONTAINER_NAME}|2026-08-29T00:00:00.000000000Z\n`;
        }
        if (command.includes("docker stop") || command.includes("docker rm -f")) return "";
        throw new Error(`unexpected cleanup command: ${command}`);
      }),
      disconnect: mock(async () => {}),
    } as DockerSSHClient;
    const dedicatedSsh = spyOn(DockerSSHClient, "createDedicated").mockReturnValue(ssh);

    await new DockerSandboxProvider().stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      {
        nodeRecordId: NODE_RECORD_ID,
        nodeIncarnation: NODE_INCARNATION,
        nodeHistoryId: NODE_HISTORY_ID,
        nodeHostname: NODE.hostname,
        nodeSshPort: NODE.ssh_port,
        nodeSshUser: NODE.ssh_user,
        nodeHostKeyFingerprint: NODE.host_key_fingerprint,
        replacementSecretCleanupVersion: 1,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        containerId: CONTAINER_ID,
        vpnNodeName: null,
        vpnRegistrationStartedAt: null,
        previousVpnNodeId: null,
        allocationCounted: true,
      },
    );

    expect(dedicatedSsh).toHaveBeenCalledTimes(1);
    expect(pooledSsh).not.toHaveBeenCalled();
    expect(ssh.disconnect).toHaveBeenCalledTimes(1);
    expect(commands).toHaveLength(5);
    expect(commands.every((command) => command.includes(NODE_INCARNATION))).toBe(true);
    expect(
      commands
        .slice(1)
        .every((command) =>
          command.includes(
            'docker() { command docker --host unix:///var/run/docker.sock --config "$exact_docker_config" "$@"; }',
          ),
        ),
    ).toBe(true);
    const volumeCleanupIndex = commands.findIndex((command) =>
      command.includes("ELIZA_EXACT_RESTORE_STAGING_VOLUME_PURGED_V1"),
    );
    const dockerRemovalIndex = commands.findIndex((command) => command.includes("docker rm -f"));
    expect(dockerRemovalIndex).toBeGreaterThanOrEqual(0);
    expect(volumeCleanupIndex).toBeGreaterThan(dockerRemovalIndex);
    expect(commands[volumeCleanupIndex]).toContain(VOLUME_PATH);
    expect(commands[volumeCleanupIndex]).toContain("rm -rf --one-file-system --");
  });

  test("rejects target occurrence drift after intent without discovery or SSH", async () => {
    const driftedNode: DockerNode = {
      ...NODE,
      node_incarnation: "88888888-8888-4888-8888-888888888888",
    };
    spyOn(dockerNodesRepository, "findByIdOnPrimary")
      .mockResolvedValueOnce(NODE)
      .mockResolvedValueOnce(driftedNode);
    const hostPortRead = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const intent = mock(async () => {});
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(nodeAutoscaler, "getNodeAutoscaler");
    const fallback = spyOn(dockerNodesRepository, "findAll");
    const ssh = spyOn(DockerSSHClient, "createDedicated");

    const error = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ onReplacementCreateIntent: intent }))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      nodeIncarnation: NODE_INCARNATION,
      nodeHistoryId: NODE_HISTORY_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
    });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_TARGET_DRIFT",
      context: { driftedKey: "nodeIncarnation" },
    });
    expect(intent).toHaveBeenCalledTimes(1);
    expect(hostPortRead).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(autoscale).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("rejects a reserved target whose attested architecture mismatches its platform", async () => {
    const incompatibleNode: DockerNode = {
      ...NODE,
      metadata: { ...NODE.metadata, architecture: "arm64" },
    };
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(incompatibleNode);
    const intent = mock(async () => {});
    const ssh = spyOn(DockerSSHClient, "createDedicated");

    const error = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ onReplacementCreateIntent: intent }))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_TARGET_PLATFORM_MISMATCH",
      context: {
        platform: "linux/amd64",
        targetArchitecture: "arm64",
      },
    });
    expect(intent).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("accepts linux/arm64 only when the node and child image prove arm64", async () => {
    const armNode: DockerNode = {
      ...NODE,
      metadata: { ...NODE.metadata, architecture: "arm64" },
    };
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(armNode);
    const { commands, stdinCommands } = installExactRestoreSsh({
      imagePlatform: "linux/arm64",
    });

    await expect(
      new DockerSandboxProvider().create(
        exactRestoreConfig({
          exactRestore: {
            ...exactRestoreConfig().exactRestore!,
            target: {
              ...exactRestoreConfig().exactRestore!.target,
              platform: "linux/arm64",
            },
          },
        }),
      ),
    ).resolves.toMatchObject({ metadata: { imagePlatform: "linux/arm64" } });

    expect(commands.some((command) => command.includes("--platform 'linux/arm64'"))).toBe(true);
    expect(stdinCommands).toHaveLength(1);
    expect(stdinCommands[0]).toContain("docker create");
    expect(stdinCommands[0]).toContain("--platform 'linux/arm64'");
  });

  test("rejects an old Docker client API before exact restore effects", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const created = mock(async () => {});
    const settled = mock(async () => {});
    const { commands, stdinCommands } = installExactRestoreSsh({
      dockerClientApiVersion: "1.47",
      dockerServerApiVersion: "1.51",
    });

    const error = await new DockerSandboxProvider()
      .create(
        exactRestoreConfig({
          onReplacementCreated: created,
          onReplacementCreateSettled: settled,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_IMAGE_PROOF_UNSUPPORTED",
      context: {
        dockerClientApiVersion: "1.47",
        dockerServerApiVersion: "1.51",
        containerdImageStore: true,
      },
    });
    expect(commands.some((command) => command.includes("docker pull"))).toBe(false);
    expect(commands.some((command) => command.includes("stat -c '%a'"))).toBe(false);
    expect(stdinCommands).toHaveLength(0);
    expect(created).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  test("rejects the legacy Docker image store before exact restore effects", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const created = mock(async () => {});
    const settled = mock(async () => {});
    const { commands, stdinCommands } = installExactRestoreSsh({
      dockerDriverStatus: [["Backing Filesystem", "extfs"]],
    });

    const error = await new DockerSandboxProvider()
      .create(
        exactRestoreConfig({
          onReplacementCreated: created,
          onReplacementCreateSettled: settled,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_IMAGE_PROOF_UNSUPPORTED",
      context: {
        dockerClientApiVersion: "1.51",
        dockerServerApiVersion: "1.51",
        containerdImageStore: false,
      },
    });
    expect(commands.some((command) => command.includes("docker pull"))).toBe(false);
    expect(commands.some((command) => command.includes("stat -c '%a'"))).toBe(false);
    expect(stdinCommands).toHaveLength(0);
    expect(created).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  test("fails closed when image inspect reports a different runtime platform", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const settled = mock(async () => {});
    installExactRestoreSsh({ imagePlatform: "linux/arm64" });

    const error = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ onReplacementCreateSettled: settled }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_IMAGE_PROOF_MISMATCH",
    });
    expect(settled).not.toHaveBeenCalled();
  });

  test("preserves the exact locator when Docker proves the candidate is running", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const settled = mock(async () => {});
    installExactRestoreSsh({ containerRunning: true });

    const error = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ onReplacementCreateSettled: settled }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      containerId: CONTAINER_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
    });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_QUARANTINE_PROOF_MISMATCH",
    });
    expect(settled).not.toHaveBeenCalled();
  });

  test("fails closed when Docker proves the index digest instead of the selected child digest", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const settled = mock(async () => {});
    installExactRestoreSsh({ repoDigests: [IMAGE_REFERENCE] });

    const error = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ onReplacementCreateSettled: settled }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_IMAGE_PROOF_MISMATCH",
      context: { imagePlatformDigest: IMAGE_PLATFORM_DIGEST },
    });
    expect(settled).not.toHaveBeenCalled();
  });

  test("rejects a different container-bound manifest even when RepoDigests contains the expected child", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const settled = mock(async () => {});
    installExactRestoreSsh({
      manifestDigest: `sha256:${"e".repeat(64)}`,
      repoDigests: [IMAGE_PLATFORM_REFERENCE, `ghcr.io/elizaos/eliza@sha256:${"e".repeat(64)}`],
    });

    const error = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ onReplacementCreateSettled: settled }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_IMAGE_PROOF_MISMATCH",
      context: { imagePlatformDigest: IMAGE_PLATFORM_DIGEST },
    });
    expect(settled).not.toHaveBeenCalled();
  });

  test("preserves the exact candidate locator when the created callback response is lost", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const createdFailure = new Error("created callback committed then response was lost");
    const settled = mock(async () => {});
    const created = mock(async () => {
      throw createdFailure;
    });
    const { stdinCommands } = installExactRestoreSsh();

    const error = await new DockerSandboxProvider()
      .create(
        exactRestoreConfig({
          onReplacementCreated: created,
          onReplacementCreateSettled: settled,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      containerId: CONTAINER_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
    });
    expect((error as Error).cause).toBe(createdFailure);
    expect(created).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    expect(stdinCommands).toHaveLength(1);
  });

  test("preserves occurrence authority when Docker create materializes but its SSH response is lost", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const transportFailure = new Error("SSH disconnected after Docker wrote the candidate id");
    const created = mock(async () => {});
    const settled = mock(async () => {});
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(nodeAutoscaler, "getNodeAutoscaler");
    const { stdinCommands } = installExactRestoreSsh({ createFailure: transportFailure });

    const error = await new DockerSandboxProvider()
      .create(
        exactRestoreConfig({
          onReplacementCreated: created,
          onReplacementCreateSettled: settled,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      containerName: CONTAINER_NAME,
      nodeId: NODE.node_id,
      nodeRecordId: NODE_RECORD_ID,
      nodeIncarnation: NODE_INCARNATION,
      nodeHistoryId: NODE_HISTORY_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
    });
    expect((error as Error).cause).toBe(transportFailure);
    expect(stdinCommands).toHaveLength(1);
    expect(created).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(autoscale).not.toHaveBeenCalled();
  });

  test("returns the proven handle and locator when the success callback response is lost", async () => {
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const settlementFailure = new Error("success committed then response was lost");
    const settled = mock(async () => {
      throw settlementFailure;
    });
    installExactRestoreSsh();

    const error = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ onReplacementCreateSettled: settled }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCreateSettlementCleanupUnresolvedError);
    expect(error).toMatchObject({
      settlement: { replacementAttemptId: REPLACEMENT_ATTEMPT_ID, outcome: "succeeded" },
      providerHandle: { metadata: { containerId: CONTAINER_ID } },
      containerId: CONTAINER_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      persistenceError: settlementFailure,
    });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test("rejects image or target fallback inputs before placement work", async () => {
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary");
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(nodeAutoscaler, "getNodeAutoscaler");
    const ssh = spyOn(DockerSSHClient, "createDedicated");

    const wrongDigest = `sha256:${"c".repeat(64)}`;
    const imageError = await new DockerSandboxProvider()
      .create(
        exactRestoreConfig({
          exactRestore: {
            ...exactRestoreConfig().exactRestore!,
            imageDigest: wrongDigest,
          },
        }),
      )
      .catch((caught: unknown) => caught);
    expect(imageError).toMatchObject({ code: "SANDBOX_EXACT_RESTORE_IMAGE_REFERENCE_INVALID" });

    const exclusionError = await new DockerSandboxProvider()
      .create(exactRestoreConfig({ excludeNodeId: NODE.node_id }))
      .catch((caught: unknown) => caught);
    expect(exclusionError).toMatchObject({
      code: "SANDBOX_EXACT_RESTORE_NODE_RESELECTION_FORBIDDEN",
    });
    expect(targetRead).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(autoscale).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });
});
