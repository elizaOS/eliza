/** Applies the shared Pi coding policy at the interactive TUI send boundary. */

import {
  type AgentClientSendBoundary,
  type PiCodingTurnParams,
  sendPiCodingTurn,
} from "./agent-client.js";

/** Sends one interactive App turn through the same profile as CLI and ACP. */
export function sendInteractiveCodingTurn(
  client: AgentClientSendBoundary,
  params: PiCodingTurnParams,
): Promise<string> {
  return sendPiCodingTurn(client, params);
}
