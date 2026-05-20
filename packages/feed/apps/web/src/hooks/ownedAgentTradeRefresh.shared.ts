export function isAgentTradeActivityMessage(
  data: Record<string, unknown>,
): boolean {
  if (data.type !== "agent_trade") {
    return false;
  }

  const activity = data.activity;
  if (!activity || typeof activity !== "object") {
    return false;
  }

  return (activity as { type?: unknown }).type === "trade";
}
