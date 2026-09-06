/**
 * Stops a captured Docker container while preserving its writable layer and
 * mounts. The lifecycle caller owns durable retention and exclusion; this
 * protocol proves stopped state and restart policy without releasing capacity.
 */
import { ElizaError } from "@elizaos/core";
import { shellQuote } from "./docker-sandbox-utils";
import type {
  SandboxRetainedResumeReceipt,
  SandboxRetainedStopReceipt,
} from "./sandbox-provider-types";

type Execute = (command: string, timeoutMs: number) => Promise<string>;

/** Executes only against an immutable ID; name reuse cannot redirect a stop. */
export async function stopDockerRetainingState(
  execute: Execute,
  containerId: string,
  agentId: string,
): Promise<SandboxRetainedStopReceipt> {
  if (
    !/^[a-f0-9]{64}$/.test(containerId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(agentId)
  ) {
    throw new ElizaError("Retained stop requires immutable container and agent identities", {
      code: "SANDBOX_RETAINED_STOP_IDENTITY_INVALID",
    });
  }
  const target = shellQuote(containerId);
  const identity = await execute(
    `docker container inspect --format '{{.Id}}|{{index .Config.Labels "ai.elizaos.agent-id"}}' ${target}`,
    15_000,
  );
  if (identity.trim() !== `${containerId}|${agentId}`) {
    throw new ElizaError("Retained container ownership does not match captured authority", {
      code: "SANDBOX_RETAINED_STOP_OWNER_MISMATCH",
      context: { containerId, agentId },
    });
  }
  // Persist restart=no before stopping so a daemon/host restart cannot revive
  // unpaid work after a lost acknowledgement or process crash.
  await execute(`docker update --restart=no ${target}`, 15_000);
  let stopError: unknown;
  try {
    await execute(`docker stop -t 10 ${target}`, 30_000);
  } catch (error) {
    // error-policy:J1 an uncertain stop is resolved only by exact readback below.
    stopError = error;
  }
  const observed = await execute(
    `docker container inspect --format '{{.Id}}|{{index .Config.Labels "ai.elizaos.agent-id"}}|{{.State.Status}}|{{.State.Running}}|{{.State.Restarting}}|{{.State.Paused}}|{{.State.Dead}}|{{.HostConfig.RestartPolicy.Name}}' ${target}`,
    15_000,
  );
  const fields = observed.trim().split("|");
  const state = fields[2];
  if (
    fields.length !== 8 ||
    fields[0] !== containerId ||
    fields[1] !== agentId ||
    (state !== "exited" && state !== "created") ||
    fields[3] !== "false" ||
    fields[4] !== "false" ||
    fields[5] !== "false" ||
    fields[6] !== "false" ||
    fields[7] !== "no"
  ) {
    throw new ElizaError("Exact retained container is not proven stopped with restart disabled", {
      code: "SANDBOX_RETAINED_STOP_UNRESOLVED",
      context: { containerId, agentId },
      cause: stopError,
    });
  }
  return { containerId, restartPolicy: "no", state };
}

/** Resolves a physical name only during read-only capture, never during mutation. */
export async function captureDockerRetainedContainer(
  execute: Execute,
  containerName: string,
  agentId: string,
): Promise<string> {
  if (
    !/^agent-[a-zA-Z0-9-]+$/.test(containerName) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(agentId)
  ) {
    throw new ElizaError("Retained capture requires a canonical agent container name", {
      code: "SANDBOX_RETAINED_CAPTURE_IDENTITY_INVALID",
    });
  }
  const observed = await execute(
    `docker container inspect --format '{{.Id}}|{{index .Config.Labels "ai.elizaos.agent-id"}}|{{.Name}}' ${shellQuote(containerName)}`,
    15_000,
  );
  const fields = observed.trim().split("|");
  if (
    fields.length !== 3 ||
    !/^[a-f0-9]{64}$/.test(fields[0]) ||
    fields[1] !== agentId ||
    fields[2] !== `/${containerName}`
  ) {
    throw new ElizaError("Retained capture does not match the expected agent and physical name", {
      code: "SANDBOX_RETAINED_CAPTURE_OWNER_MISMATCH",
      context: { containerName, agentId },
    });
  }
  return fields[0];
}

/** Restarts only the retained immutable container; restart policy stays fenced. */
export async function resumeDockerRetainedContainer(
  execute: Execute,
  containerId: string,
  agentId: string,
): Promise<SandboxRetainedResumeReceipt> {
  if (
    !/^[a-f0-9]{64}$/.test(containerId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(agentId)
  ) {
    throw new ElizaError("Retained resume requires immutable agent/container identity", {
      code: "SANDBOX_RETAINED_RESUME_IDENTITY_INVALID",
    });
  }
  const probe = `docker container inspect --format '{{.Id}}|{{index .Config.Labels "ai.elizaos.agent-id"}}|{{.State.Status}}|{{.State.Running}}|{{.State.Restarting}}|{{.State.Paused}}|{{.State.Dead}}|{{.HostConfig.RestartPolicy.Name}}' ${shellQuote(containerId)}`;
  const read = async () => {
    const fields = (await execute(probe, 15_000)).trim().split("|");
    if (
      fields.length !== 8 ||
      fields[0] !== containerId ||
      fields[1] !== agentId ||
      !["running", "exited", "created"].includes(fields[2]) ||
      fields[4] !== "false" ||
      fields[5] !== "false" ||
      fields[6] !== "false" ||
      fields[7] !== "no" ||
      fields[3] !== (fields[2] === "running" ? "true" : "false")
    ) {
      throw new ElizaError("Retained resume cannot prove exact container state", {
        code: "SANDBOX_RETAINED_RESUME_UNRESOLVED",
      });
    }
    return fields[2];
  };
  if ((await read()) !== "running") {
    let startError: unknown;
    try {
      await execute(`docker start ${shellQuote(containerId)}`, 30_000);
    } catch (error) {
      // error-policy:J1 exact readback resolves a lost start acknowledgement.
      startError = error;
    }
    if ((await read()) !== "running")
      throw new ElizaError("Retained container did not start", {
        code: "SANDBOX_RETAINED_RESUME_NOT_RUNNING",
        cause: startError,
      });
  }
  return { containerId, state: "running", restartPolicy: "no" };
}
