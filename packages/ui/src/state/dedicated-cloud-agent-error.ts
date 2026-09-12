/** Classifies the terminal dedicated-agent proxy failure that requires choosing another Cloud agent. */

import {
  dedicatedCloudAgentIdFromBase,
  isDedicatedCloudAgentBase,
  resolveCloudEnvironmentBase,
} from "../utils/cloud-agent-base";
import type { StartupErrorState } from "./types";

/** A deliberate shutdown needs management, not warmup or a new agent selection. */
export function describeStoppedDedicatedCloudAgent(args: {
  status?: number;
  code?: string;
  clientBaseUrl: string;
  phase: StartupErrorState["phase"];
}): StartupErrorState | null {
  if (
    args.status !== 409 ||
    args.code !== "agent_stopped" ||
    !isDedicatedCloudAgentBase(args.clientBaseUrl)
  ) {
    return null;
  }
  return {
    reason: "agent-stopped",
    phase: args.phase,
    status: 409,
    message: "Your Dedicated agent is shut down.",
    cloudAgentId:
      dedicatedCloudAgentIdFromBase(args.clientBaseUrl) ?? undefined,
    cloudManagementUrl: `${resolveCloudEnvironmentBase({ apiBase: args.clientBaseUrl })}/join`,
  };
}

const LEGACY_ERROR_STATE_FRAGMENT = "Agent is in an error state";
const CONTROL_PLANE_STATES = new Set([
  "sleeping",
  "stopped",
  "suspended",
  "error",
]);

function structuredAgentStatus(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const outer = data as Record<string, unknown>;
  const payload = outer.data;
  if (!payload || typeof payload !== "object") return null;
  const status = (payload as Record<string, unknown>).status;
  return typeof status === "string" ? status.toLowerCase() : null;
}

export function isTerminalDedicatedCloudAgentErrorState(args: {
  status: number | undefined;
  code?: string;
  message: string | null | undefined;
  data?: unknown;
  clientBaseUrl: string;
}): boolean {
  return (
    args.status === 503 &&
    isDedicatedCloudAgentBase(args.clientBaseUrl) &&
    (args.code === "agent_error_state" ||
      (args.code === "agent_not_running" &&
        CONTROL_PLANE_STATES.has(structuredAgentStatus(args.data) ?? "")) ||
      (typeof args.message === "string" &&
        args.message.includes(LEGACY_ERROR_STATE_FRAGMENT)))
  );
}
