/** Observes and retires an immutable Docker runtime on verified node authority. Read-only observation is separate from exact-ID removal; neither changes compute leases or releases capacity. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { logger } from "../utils/logger";
import { buildAgentContainerLabelArgs, shellQuote } from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";
import {
  runtimeIdentitySchema,
  type SandboxRuntimeObservation,
  type SandboxRuntimeObservationRequest,
} from "./sandbox-runtime-observation";

const DOCKER_RUNTIME_INSPECTION_PROGRAM = `
import json, os, re, subprocess, sys
request = json.load(sys.stdin)
if open('/proc/sys/kernel/random/boot_id').read().strip() != request['nodeIncarnation']:
    raise RuntimeError('node_incarnation_changed')
env = {k:v for k,v in os.environ.items() if not k.startswith('DOCKER_')}
def docker(*args, timeout=5):
    result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *args], capture_output=True, text=True, timeout=timeout, env=env)
    if result.returncode != 0: raise RuntimeError('docker_observation_unavailable')
    return result.stdout
name = request['containerName']
ids = docker('ps', '-aq', '--no-trunc', '--filter', 'name=^/' + re.escape(name) + '$').split()
expected = request.get('containerId')
if expected:
    original = docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + expected).split()
    if original not in ([], [expected]): raise RuntimeError('ambiguous_original_identity')
    if ids and ids != [expected]: raise RuntimeError('same_name_replacement')
    if not original:
        print(json.dumps({'kind':'absent'})); sys.exit(0)
    if ids != [expected]: raise RuntimeError('original_container_renamed')
if len(ids) != 1: raise RuntimeError('original_identity_unavailable')
state = json.loads(docker('inspect', '--format', '{{json .}}', ids[0]))
if state['Id'] != ids[0] or state['Name'] != '/' + name: raise RuntimeError('container_identity_changed')
`;
export const DOCKER_RUNTIME_OBSERVATION_PROGRAM =
  DOCKER_RUNTIME_INSPECTION_PROGRAM +
  `
print(json.dumps({'kind':'present', 'containerId':state['Id'], 'labels':state['Config']['Labels'] or {}, 'running':state['State']['Running']}))
`;
export const DOCKER_RUNTIME_STOP_PROGRAM =
  DOCKER_RUNTIME_INSPECTION_PROGRAM +
  `
labels = state['Config']['Labels'] or {}
if labels.get('ai.elizaos.managed-by') != 'eliza-cloud' or labels.get('ai.elizaos.agent-id') != request['agentId'] or labels.get('ai.elizaos.org-id') != request['organizationId'] or labels.get('ai.elizaos.container-class') not in ('user','test'):
    raise RuntimeError('container_ownership_changed')
if not expected or state['Id'] != expected: raise RuntimeError('immutable_stop_identity_required')
docker('stop', '--time', '10', expected, timeout=15)
docker('rm', '-f', expected)
if docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + expected).split(): raise RuntimeError('original_removal_unresolved')
print(json.dumps({'kind':'absent'}))
`;
const wireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z
    .object({
      kind: z.literal("present"),
      containerId: z.string().regex(/^[a-f0-9]{64}$/),
      labels: z.record(z.string(), z.string()),
      running: z.boolean(),
    })
    .strict(),
]);

async function runDockerRuntimeObservation(
  input: SandboxRuntimeObservationRequest,
  stop = false,
): Promise<SandboxRuntimeObservation> {
  const expected = input.expected ? runtimeIdentitySchema.parse(input.expected) : undefined;
  if (
    expected &&
    (expected.agentId !== input.agentId ||
      expected.organizationId !== input.organizationId ||
      expected.nodeId !== input.nodeId ||
      expected.containerName !== input.containerName)
  ) {
    throw new ElizaError("Prepared runtime identity belongs to another source", {
      code: "SANDBOX_RUNTIME_IDENTITY_MISMATCH",
    });
  }
  const node = expected
    ? await dockerNodesRepository.findByIdOnPrimary(expected.nodeRecordId)
    : await dockerNodesRepository.findByNodeIdOnPrimary(input.nodeId);
  if (
    !node ||
    !node.node_incarnation ||
    !node.current_node_history_id ||
    !node.host_key_fingerprint
  ) {
    return { kind: "unavailable", reason: "Exact node authority is unavailable" };
  }
  const authority = {
    organizationId: input.organizationId,
    agentId: input.agentId,
    nodeId: node.node_id,
    nodeRecordId: node.id,
    nodeIncarnation: node.node_incarnation,
    nodeHistoryId: node.current_node_history_id,
    hostname: node.hostname,
    sshPort: node.ssh_port,
    sshUser: node.ssh_user,
    hostKeyFingerprint: node.host_key_fingerprint,
    containerName: input.containerName,
  };
  if (
    expected &&
    Object.entries(authority).some(([key, value]) => Reflect.get(expected, key) !== value)
  ) {
    throw new ElizaError("Prepared runtime node authority changed", {
      code: "SANDBOX_RUNTIME_NODE_CHANGED",
    });
  }
  const ssh = DockerSSHClient.createDedicated(
    node.hostname,
    node.ssh_port,
    node.host_key_fingerprint,
    node.ssh_user,
  );
  try {
    const output = await ssh.execStdin(
      `python3 -c ${shellQuote(stop ? DOCKER_RUNTIME_STOP_PROGRAM : DOCKER_RUNTIME_OBSERVATION_PROGRAM)}`,
      JSON.stringify({ ...authority, containerId: expected?.containerId }),
      60_000,
    );
    const observed = wireSchema.parse(JSON.parse(output));
    if (observed.kind === "absent") {
      if (!expected)
        return { kind: "unavailable", reason: "Original container identity was not recorded" };
      return { kind: "absent", identity: expected };
    }
    const containerClass = observed.labels["ai.elizaos.container-class"];
    if (containerClass !== "user" && containerClass !== "test")
      throw new Error("Container class is not eligible for agent suspension");
    for (const [key, value] of buildAgentContainerLabelArgs({
      agentId: input.agentId,
      organizationId: input.organizationId,
      containerClass,
    })) {
      if (observed.labels[key] !== value) throw new Error("Container ownership labels changed");
    }
    if (expected && observed.containerId !== expected.containerId)
      throw new Error("Original runtime was replaced");
    return {
      kind: "present",
      identity: runtimeIdentitySchema.parse({ ...authority, containerId: observed.containerId }),
      running: observed.running,
    };
  } catch (cause) {
    // error-policy:J2 Exact removal preserves the failed transport or authority cause.
    if (stop)
      throw new ElizaError("Exact runtime stop was not confirmed", {
        code: "SANDBOX_EXACT_STOP_UNRESOLVED",
        cause,
      });
    // error-policy:J4 An unavailable observation cannot authorize provider removal or recovery.
    return {
      kind: "unavailable",
      reason: cause instanceof Error ? cause.message : "Runtime observation failed",
    };
  } finally {
    try {
      await ssh.disconnect();
    } catch (cause) {
      // error-policy:J6 This dedicated SSH session is owned by the observation or exact stop.
      logger.warn("[docker-runtime-observation] SSH teardown failed", { cause });
    }
  }
}

export async function observeDockerRuntime(
  input: SandboxRuntimeObservationRequest,
): Promise<SandboxRuntimeObservation> {
  return runDockerRuntimeObservation(input);
}
export async function stopDockerRuntime(
  identity: import("./sandbox-runtime-observation").SandboxRuntimeIdentity,
): Promise<void> {
  const result = await runDockerRuntimeObservation(
    {
      agentId: identity.agentId,
      organizationId: identity.organizationId,
      nodeId: identity.nodeId,
      containerName: identity.containerName,
      expected: identity,
    },
    true,
  );
  if (result.kind !== "absent")
    throw new ElizaError("Exact runtime removal is unresolved", {
      code: "SANDBOX_EXACT_STOP_UNRESOLVED",
    });
}
