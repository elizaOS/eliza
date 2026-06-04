import { eq } from "drizzle-orm";
import { dbRead } from "./client";
import { type AgentSandbox, agentSandboxes } from "./schemas/agent-sandboxes";

export interface AgentSandboxRoutingFields {
  status: AgentSandbox["status"];
  bridge_url: AgentSandbox["bridge_url"];
  bridge_port: AgentSandbox["bridge_port"];
  headscale_ip: AgentSandbox["headscale_ip"];
  web_ui_port: AgentSandbox["web_ui_port"];
}

export async function findAgentSandboxRoutingById(
  id: string,
): Promise<AgentSandboxRoutingFields | undefined> {
  const [row] = await dbRead
    .select({
      status: agentSandboxes.status,
      bridge_url: agentSandboxes.bridge_url,
      bridge_port: agentSandboxes.bridge_port,
      headscale_ip: agentSandboxes.headscale_ip,
      web_ui_port: agentSandboxes.web_ui_port,
    })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, id))
    .limit(1);
  return row;
}
