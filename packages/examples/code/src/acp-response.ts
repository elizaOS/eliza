/**
 * Publishes the completed, parsed Eliza reply at the ACP transport boundary.
 * The inner runtime's streaming chunks are planner protocol data, so callers
 * supply only the authoritative response returned after the turn completes.
 */

export interface AcpTextUpdate {
  sessionId: string;
  update: {
    sessionUpdate: "agent_message_chunk";
    content: { type: "text"; text: string };
  };
}

export async function publishParsedReply(
  sessionId: string,
  response: string,
  publish: (update: AcpTextUpdate) => Promise<unknown>,
): Promise<void> {
  if (!response.trim()) return;

  await publish({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: response },
    },
  });
}
