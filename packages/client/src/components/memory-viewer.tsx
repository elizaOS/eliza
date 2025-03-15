import type { UUID } from "@elizaos/core";
import { Book, Database, MessageSquare, Trash2 } from "lucide-react";
import { useAgentMemories, useDeleteMemory } from "../hooks/use-query-hooks";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

import type { Memory } from "@elizaos/core";

export function AgentMemoryViewer({ agentId }: { agentId: UUID }) {
	const { data: memories = [], isLoading, error } = useAgentMemories(agentId);
	const { mutate: deleteMemory } = useDeleteMemory();
	
	if (isLoading && (!memories || memories.length === 0)) {
		return <div className="flex items-center justify-center h-40">Loading memories...</div>;
	}
	
	if (error) {
		return (
			<div className="flex items-center justify-center h-40 text-destructive">
				Error loading agent memories
			</div>
		);
	}

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp);
		return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
	};

	const getMemoryIcon = (memoryType: string | undefined) => {
		if (memoryType?.includes("message")) return <MessageSquare className="w-4 h-4" />;
		if (memoryType?.includes("document")) return <Book className="w-4 h-4" />;
		return <Database className="w-4 h-4" />;
	};

	const handleDelete = (memoryId: string) => {
		if (memoryId && window.confirm("Are you sure you want to delete this memory entry?")) {
			deleteMemory({ agentId, memoryId });
		}
	};

	return (
		<div className="flex flex-col h-[calc(100vh-200px)] min-h-[400px] w-full">
			<h3 className="text-lg font-medium mb-4 px-4 pt-4 flex-none">Agent Memories</h3>
			<div className="flex-1 overflow-y-auto px-4 pb-4" style={{ height: "calc(100% - 60px)", overflowY: "auto" }}>
				{memories.length === 0 ? (
					<div className="text-muted-foreground text-center p-4">No memories recorded yet</div>
				) : (
					<div className="space-y-3">
						{memories.map((memory: Memory, index: number) => {
							const memoryType = memory.metadata?.type || "Memory";		
							return (
								<div 
									key={memory.id || index} 
									className="border rounded-md p-3 bg-card hover:bg-accent/10 transition-colors relative group"
								>
									{memory.id && (
										<Button
											variant="secondary"
											size="icon"
											className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-50"
											onClick={() => handleDelete(memory.id!)}
											title="Delete memory entry"
										>
											<Trash2 className="h-4 w-4 text-regular" />
										</Button>
									)}
									
									<div className="flex items-center justify-between">
										<span className="text-sm font-medium flex items-center gap-2">
											{getMemoryIcon(memoryType)} {memoryType}
										</span>
										<Badge variant="outline" className="text-xs group-hover:mr-8 transition-all">
											{formatDate(memory.createdAt || 0)}
										</Badge>
									</div>
									
									<div className="mt-2 grid gap-2 rounded-full">
										{memory.id && (
											<div className="text-xs bg-muted px-2 py-1 rounded">
												<span className="font-semibold">ID: </span>
												{memory.id}
											</div>
										)}
										
										{memory.content && (
											<div className="text-xs bg-muted px-2 py-1 rounded max-h-40 overflow-y-auto">
												<span className="font-semibold">Content: </span>
												{typeof memory.content === 'object' 
													? JSON.stringify(memory.content, null, 2)
													: memory.content}
											</div>
										)}
										
										{memory.metadata && Object.keys(memory.metadata).length > 0 && (
											<div className="text-xs bg-muted px-2 py-1 rounded max-h-32 overflow-y-auto">
												<span className="font-semibold">Metadata: </span>
												{typeof memory.metadata === 'object' 
													? JSON.stringify(memory.metadata, null, 2)
													: memory.metadata}
											</div>
										)}
										
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
