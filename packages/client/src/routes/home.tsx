import PageTitle from "@/components/page-title";
import ProfileCard from "@/components/profile-card";
import { Card } from "@/components/ui/card";
import { useAgentManagement } from "@/hooks/use-agent-management";
import { useAgents } from "@/hooks/use-query-hooks";
import { formatAgentName } from "@/lib/utils";
import type { Agent } from "@elizaos/core";
import { Cog, Loader2, MessageSquare, Play, Plus, Square } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function Home() {
	const {
		data: { data: agentsData } = {},
		isLoading,
		isError,
		error,
	} = useAgents();
	const navigate = useNavigate();

	// Use the agent management hook
	const { startAgent, stopAgent, isAgentStarting, isAgentStopping } =
		useAgentManagement();

	// Extract agents properly from the response
	const agents = agentsData?.agents || [];

	return (
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

			{!isLoading && !isError && (
				<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{agents
						?.sort(
							(a: Agent, b: Agent) => Number(b?.enabled) - Number(a?.enabled),
						)
						.map((agent: Agent) => {
							// Use type assertion to access status property
							const isActive =
								(agent as Agent & { status?: string }).status === "active";
							const isStarting = isAgentStarting(agent.id);
							const isStopping = isAgentStopping(agent.id);
							const isProcessing = isStarting || isStopping;

							let buttonLabel = "Start";
							let buttonIcon = <Play />;

							if (isStarting) {
								buttonLabel = "Starting...";
								buttonIcon = <Loader2 className="animate-spin" />;
							} else if (isStopping) {
								buttonLabel = "Stopping...";
								buttonIcon = <Loader2 className="animate-spin" />;
							} else if (isActive) {
								buttonLabel = "Stop";
								buttonIcon = <Square fill="#EF4444" size={16} />;
							}

							return (
								<ProfileCard
									key={agent.id}
									title={agent.name}
									content={formatAgentName(agent.name)}
									buttons={[
										{
											label: buttonLabel,
											icon: buttonIcon,
											action: () => {
												if (isProcessing) return; // Prevent action while processing

												if (!isActive) {
													startAgent(agent);
												} else {
													stopAgent(agent);
												}
											},
											className: `w-full grow ${isActive ? "text-red-500" : ""} ${isProcessing ? "opacity-80 cursor-not-allowed" : ""}`,
											variant: !isActive ? "default" : "secondary",
											disabled: isProcessing,
										},
										{
											icon: <MessageSquare style={{ height: 14, width: 14 }} />,
											className: "w-10 h-10 rounded-full",
											action: () => navigate(`/chat/${agent.id}`),
											variant: "outline",
											disabled: !isActive,
										},
										{
											icon: <Cog style={{ height: 16, width: 16 }} />,
											className: "w-10 h-10 rounded-full",
											action: () => navigate(`/settings/${agent.id}`),
											variant: "outline",
										},
									]}
								/>
							);
						})}

					{/* Create new agent card */}
					<Card
						className="flex flex-col items-center justify-center h-full cursor-pointer hover:bg-accent/50 transition-colors"
						onClick={() => navigate("/create")}
					>
						<div className="flex flex-col items-center justify-center gap-2 p-8">
							<Plus size={40} className="text-muted-foreground" />
							<span className="text-muted-foreground whitespace-nowrap">
								Create New Agent
							</span>
						</div>
					</Card>
				</div>
			)}
		</div>
	);
}
