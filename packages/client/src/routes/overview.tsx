import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import Overview from "@/components/overview";
import { useParams } from "react-router";
import type { UUID } from "@elizaos/core";

export default function AgentRoute() {
    const { agentId } = useParams<{ agentId: UUID }>();

    const query = useQuery({
        queryKey: ["agent", agentId],
        queryFn: () => apiClient.getAgent(agentId ?? ""),
        refetchInterval: 5_000,
        enabled: Boolean(agentId),
    });

    if (!agentId) return <div>No data.</div>;

    const character = query?.data?.character;

    if (!character) return null;

    return <Overview character={character} />;
}
