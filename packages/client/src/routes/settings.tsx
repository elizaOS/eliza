import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import AgentSettings from "@/components/agent-settings";
import { useParams } from "react-router";
import type { UUID } from "@elizaos/core";
import { STALE_TIMES } from "@/hooks/use-query-hooks";

export default function AgentRoute() {
	const { agentId } = useParams<{ agentId: UUID }>();

	const query = useQuery({
		queryKey: ["agent", agentId],
		queryFn: () => apiClient.getAgent(agentId ?? ""),
		// Use polling for real-time updates
		staleTime: STALE_TIMES.FREQUENT,
		refetchInterval: 5000, // Poll every 5 seconds
		enabled: Boolean(agentId),
	});

	if (!agentId) return <div>No data.</div>;

	const agent = query?.data?.data;

	if (!agent) return null;

	return <AgentSettings agent={agent} agentId={agentId} />;
}
