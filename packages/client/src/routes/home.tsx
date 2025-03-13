import PageTitle from "@/components/page-title";
import ProfileCard from "@/components/profile-card";
import { Card } from "@/components/ui/card";
import { useAgents } from "@/hooks/use-query-hooks";
import { formatAgentName } from "@/lib/utils";
import type { Agent } from "@elizaos/core";
import { Cog, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import ProfileOverlay from "@/components/profile-overlay";
import { useState } from "react";

export default function Home() {
	const {
		data: { data: agentsData } = {},
		isLoading,
		isError,
		error,
	} = useAgents();
	const navigate = useNavigate();

	// Extract agents properly from the response
	const agents = agentsData?.agents || [];

	const [isOverlayOpen, setOverlayOpen] = useState(false);
    const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

    const openOverlay = (agent: Agent) => {
        setSelectedAgent(agent);
        setOverlayOpen(true);
    };

    const closeOverlay = () => {
        setSelectedAgent(null);
        setOverlayOpen(false);
    };

	return (
		<>
			<div className="flex flex-col gap-4 h-full p-4">
				<div className="flex items-center justify-between">
					<PageTitle title="Agents" />
				</div>

				{isLoading && <div className="text-center py-8">Loading agents...</div>}

				{isError && (
					<div className="text-center py-8 text-destructive">
						Error loading agents:{" "}
						{error instanceof Error ? error.message : "Unknown error"}
					</div>
				)}

				{agents.length === 0 && !isLoading && (
					<div className="text-center py-8 flex flex-col items-center gap-4">
						<p className="text-muted-foreground">
							No agents currently running. Start a character to begin.
						</p>
					</div>
				)}

				{!isLoading && !isError &&(
					<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-3">
						{agents?.sort((a: Agent, b: Agent) => Number(b?.enabled) - Number(a?.enabled)).map((agent: Agent) => {
							return (
								<ProfileCard
									key={agent.id}
									title={agent.name}
									content={
										<div className="cursor-pointer h-full w-full flex items-center justify-center" onClick={() => openOverlay(agent)}>
											{
												agent.settings.thumbnail ?
													<img src={agent.settings.thumbnail} alt="Agent Thumbnail" className="w-full h-full object-contain" /> :
													formatAgentName(agent.name)
											}
										</div>
										
									}
									buttons={[
										{
											label: "View",
											action: () => {
												openOverlay(agent)
											},
											className: `w-[80%]`,
											variant: "default",
										},
										{
											icon: <Cog style={{ height: 16, width: 16 }} />,
											className: "w-10 h-10 rounded-full",
											action: () => navigate(`/settings/${agent.id}`),
											variant: "outline",
										},
									]} 
								/>
							)
						})}
						{/* Create new agent card */}
						<Card className="flex flex-col items-center justify-center h-full cursor-pointer hover:bg-accent/50 transition-colors"
							onClick={() => navigate("/create")}>
							<div className="flex flex-col items-center justify-center gap-2 p-8">
								<Plus size={40} className="text-muted-foreground" />
								<span className="text-muted-foreground whitespace-nowrap">Create New Agent</span>
							</div>
						</Card>
					</div>
                        
                )}
			</div>
			<ProfileOverlay 
                isOpen={isOverlayOpen} 
                onClose={closeOverlay} 
                agent={agents.find((a) => a.id === selectedAgent?.id) || selectedAgent}
                agents={agents}
            />
		</>
	);
}
