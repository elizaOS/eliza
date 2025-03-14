import type { UUID } from "@elizaos/core";
import { useAgentActions } from "../hooks/use-query-hooks";
import { Badge } from "./ui/badge";

export function AgentActionViewer({ agentId, roomId }: { agentId: UUID; roomId?: UUID }) {
	const { data: actions = [], isLoading, error } = useAgentActions(agentId, roomId);
	
	if (isLoading && (!actions || actions.length === 0)) {
		return <div className="flex items-center justify-center h-40">Loading actions...</div>;
	}
	
	if (error) {
		return (
			<div className="flex items-center justify-center h-40 text-destructive">
				Error loading agent actions
			</div>
		);
	}

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp);
		return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
	};

	const getModelIcon = (modelType: string) => {
		if (modelType?.includes("TEXT_EMBEDDING")) return "🧠";
		if (modelType?.includes("LLM")) return "💬";
		if (modelType?.includes("IMAGE")) return "🖼️";
		return "🤖";
	};

	return (
		<div className="flex-1 overflow-auto p-4">
			<h3 className="text-lg font-medium mb-4">Agent Actions</h3>
			{actions.length === 0 ? (
				<div className="text-muted-foreground text-center p-4">No actions recorded yet</div>
			) : (
				<div className="space-y-3">
					{actions.map((action, index) => {
						const modelType = action.body?.modelType || "";
						const actionType = action.type || "Action";
						
						return (
							<div key={action.id || index} className="border rounded-md p-3 bg-card hover:bg-accent/10 transition-colors">
								<div className="flex items-center justify-between">
									<span className="text-sm font-medium flex items-center gap-2">
										{getModelIcon(modelType)} {actionType}
									</span>
									<Badge variant="outline" className="text-xs">
										{formatDate(action.createdAt)}
									</Badge>
								</div>
								
								<div className="mt-2 grid gap-2">
									{action.body?.modelKey && (
										<div className="text-xs bg-muted px-2 py-1 rounded">
											<span className="font-semibold">Model: </span>
											{action.body.modelKey}
										</div>
									)}
									
									{action.body?.params && (
										<div className="text-xs overflow-hidden">
											<span className="font-semibold">Params: </span>
											{typeof action.body.params === 'object' 
												? JSON.stringify(action.body.params, null, 2)
												: action.body.params}
										</div>
									)}
									
									{action.body?.response && action.body.response !== "[array]" && (
										<div className="text-xs overflow-hidden max-h-24 overflow-y-auto">
											<span className="font-semibold">Response: </span>
											{typeof action.body.response === 'object'
												? JSON.stringify(action.body.response, null, 2)
												: action.body.response}
										</div>
									)}
									
									{action.body?.response === "[array]" && (
										<div className="text-xs italic text-muted-foreground">
											Response contains array data
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}