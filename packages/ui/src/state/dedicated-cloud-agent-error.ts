/** Classifies the terminal dedicated-agent proxy failure that requires choosing another Cloud agent. */

import { isDedicatedCloudAgentBase } from "../utils/cloud-agent-base";

const LEGACY_ERROR_STATE_FRAGMENT = "Agent is in an error state";

export function isTerminalDedicatedCloudAgentErrorState(args: {
  status: number | undefined;
  code?: string;
  message: string | null | undefined;
  clientBaseUrl: string;
}): boolean {
  return (
    args.status === 503 &&
    isDedicatedCloudAgentBase(args.clientBaseUrl) &&
    (args.code === "agent_error_state" ||
      (typeof args.message === "string" &&
        args.message.includes(LEGACY_ERROR_STATE_FRAGMENT)))
  );
}
