import { apiClient } from "@/lib/api";
import { WorldManager } from "@/lib/world-manager";
import type { Agent, Content, Media, UUID } from "@elizaos/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "./use-toast";

// Define the ContentWithUser type
type ContentWithUser = Content & {
	name: string;
	createdAt: number;
	isLoading?: boolean;
	worldId?: string;
	id?: string; // Add optional ID field
};

// Define the Memory type needed for the useMessages hook
type Memory = {
	id: UUID;
	entityId: string;
	content: {
		text: string;
		attachments?: Media[];
		source?: string;
		actions?: string[];
	};
	createdAt: number;
	worldId?: string;
};

// Constants for stale times
export const STALE_TIMES = {
	FREQUENT: 30 * 1000, // 30 seconds - for data that changes often
	STANDARD: 2 * 60 * 1000, // 2 minutes - default
	RARE: 10 * 60 * 1000, // 10 minutes - for rarely changing data
	NEVER: Number.POSITIVE_INFINITY, // Only refetch on explicit invalidation
};

// Network Information API interface
interface NetworkInformation {
	effectiveType: "slow-2g" | "2g" | "3g" | "4g" | "unknown";
	saveData: boolean;
	[key: string]: unknown;
}

// Network status detection for smart polling
const useNetworkStatus = () => {
	// Get navigator.connection if available (Network Information API)
	const connection =
		typeof navigator !== "undefined" && "connection" in navigator
			? (navigator as Navigator & { connection: NetworkInformation }).connection
			: null;

	// Return the effective connection type or a default value
	return {
		isOffline: typeof navigator !== "undefined" && !navigator.onLine,
		effectiveType: connection?.effectiveType || "unknown",
		saveData: connection?.saveData || false,
	};
};

// Hook for fetching agents with smart polling
export function useAgents(options = {}) {
	const network = useNetworkStatus();

	return useQuery<{ data: { agents: Agent[] } }>({
		queryKey: ["agents"],
		queryFn: () => apiClient.getAgents(),
		staleTime: STALE_TIMES.FREQUENT, // Use shorter stale time for real-time data
		// Use more frequent polling for real-time updates
		refetchInterval: !network.isOffline ? STALE_TIMES.FREQUENT : false,
		// Disable polling when the tab is not active
		refetchIntervalInBackground: false,
		// Configure based on network conditions
		...(!network.isOffline &&
			network.effectiveType === "slow-2g" && {
				refetchInterval: STALE_TIMES.STANDARD, // Poll less frequently on slow connections
			}),
		// Allow overriding any options
		...options,
	});
}

// Hook for fetching a specific agent with smart polling
export function useAgent(agentId: UUID | undefined | null, options = {}) {
	const network = useNetworkStatus();

	return useQuery({
		queryKey: ["agent", agentId],
		queryFn: () => apiClient.getAgent(agentId || ""),
		staleTime: STALE_TIMES.FREQUENT, // Use shorter stale time for real-time data
		enabled: Boolean(agentId),
		// Use more frequent polling for real-time updates
		refetchInterval:
			!network.isOffline && Boolean(agentId) ? STALE_TIMES.FREQUENT : false,
		// Disable polling when the tab is not active
		refetchIntervalInBackground: false,
		// Configure based on network conditions
		...(!network.isOffline &&
			network.effectiveType === "slow-2g" && {
				refetchInterval: STALE_TIMES.STANDARD, // Poll less frequently on slow connections
			}),
		// Allow overriding any options
		...options,
	});
}

// Hook for starting an agent with optimistic updates
export function useStartAgent() {
	const queryClient = useQueryClient();
	const { toast } = useToast();

	return useMutation({
		mutationFn: async (agentId: UUID) => {
			try {
				return await apiClient.startAgent(agentId);
			} catch (error) {
				// Capture specific error types
				if (error instanceof Error) {
					if (error.message.includes("network")) {
						throw new Error(
							"Network error: Please check your connection and try again.",
						);
					}
					if (error.message.includes("already running")) {
						throw new Error("Agent is already running.");
					}
				}
				throw error; // Re-throw if not a specific case we handle
			}
		},
		onMutate: async (agentId) => {
			// Optimistically update UI to show agent is starting
			toast({
				title: "Starting Agent",
				description: "Initializing agent...",
			});

			// Return context for potential rollback
			return { agentId };
		},
		onSuccess: (data) => {
			// Immediately invalidate the queries for fresh data
			queryClient.invalidateQueries({ queryKey: ["agents"] });
			queryClient.invalidateQueries({ queryKey: ["active-agents"] });
			if (data?.id) {
				queryClient.invalidateQueries({ queryKey: ["agent", data.id] });
			}

			toast({
				title: "Agent Started",
				description: `${data?.name || "Agent"} is now running`,
			});
		},
		onError: (error) => {
			// Handle specific error cases
			const errorMessage =
				error instanceof Error ? error.message : "Failed to start agent";

			toast({
				title: "Error Starting Agent",
				description: `${errorMessage}. Please try again.`,
				variant: "destructive",
			});
		},
	});
}

// Hook for stopping an agent with optimistic updates
export function useStopAgent() {
	const queryClient = useQueryClient();
	const { toast } = useToast();

	return useMutation({
		mutationFn: (agentId: string) => apiClient.stopAgent(agentId),
		onMutate: async (agentId) => {
			// Optimistically update the UI
			// Get the agent data from the cache
			const agent = queryClient.getQueryData<Agent>(["agent", agentId]);

			if (agent) {
				toast({
					title: "Stopping Agent",
					description: `Stopping ${agent.name}...`,
				});
			}
		},
		onSuccess: (_, agentId) => {
			// Immediately invalidate the queries for fresh data
			queryClient.invalidateQueries({ queryKey: ["agents"] });
			queryClient.invalidateQueries({ queryKey: ["agent", agentId] });

			toast({
				title: "Agent Stopped",
				description: "The agent has been successfully stopped",
			});
		},
		onError: (error, agentId) => {
			// Force invalidate on error
			queryClient.invalidateQueries({ queryKey: ["agents"] });
			queryClient.invalidateQueries({ queryKey: ["agent", agentId] });

			toast({
				title: "Error",
				description:
					error instanceof Error ? error.message : "Failed to stop agent",
				variant: "destructive",
			});
		},
	});
}

// Hook for fetching messages directly for a specific agent without requiring a room
export function useAgentMessages(agentId: UUID) {
	const queryClient = useQueryClient();
	const worldId = WorldManager.getWorldId();

	// Get messages from cache or set default empty array
	const messages =
		queryClient.getQueryData<ContentWithUser[]>([
			"messages",
			agentId,
			worldId,
		]) || [];

	return {
		messages,
	};
}

// The original useMessages hook remains for backward compatibility
export function useMessages(
	agentId: UUID,
	roomId: UUID,
): {
	data: Memory[] | undefined;
	isLoading: boolean;
	isError: boolean;
	error: unknown;
	loadOlderMessages: () => Promise<boolean>;
	hasOlderMessages: boolean;
	isLoadingMore: boolean;
} {
	const queryClient = useQueryClient();
	const worldId = WorldManager.getWorldId();
	const [oldestMessageTimestamp, setOldestMessageTimestamp] = useState<
		number | null
	>(null);
	const [hasMoreMessages, setHasMoreMessages] = useState<boolean>(true);
	const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);

	// Initial fetch of messages
	const messagesQuery = useQuery({
		queryKey: ["messages", agentId, roomId, worldId],
		queryFn: () => apiClient.getMemories(agentId, roomId),
		select: (data: { memories: Memory[] }): Memory[] => {
			if (!data?.memories) return [];

			// Update the oldest message timestamp if we have messages
			if (data.memories.length > 0) {
				const timestamps: number[] = data.memories.map(
					(msg): number => msg.createdAt,
				);
				const oldest: number = Math.min(...timestamps);
				setOldestMessageTimestamp(oldest);

				// If we got less than the expected page size, there are probably no more messages
				setHasMoreMessages(data.memories.length >= 20); // Assuming default page size is 20
			} else {
				setHasMoreMessages(false);
			}

			return data.memories;
		},
		staleTime: STALE_TIMES.FREQUENT,
	});

	// Function to load older messages
	const loadOlderMessages = async (): Promise<boolean> => {
		if (!oldestMessageTimestamp || !hasMoreMessages || isLoadingMore)
			return false;

		try {
			setIsLoadingMore(true);

			// Fetch messages older than the oldest one we currently have
			const response = await apiClient.getMemories(agentId, roomId, {
				before: oldestMessageTimestamp,
				limit: 20, // Fetch up to 20 older messages
			});

			if (response?.memories && response.memories.length > 0) {
				// Update the oldest message timestamp
				const timestamps: number[] = response.memories.map(
					(msg: Memory): number => msg.createdAt,
				);
				const oldest: number = Math.min(...timestamps);
				setOldestMessageTimestamp(oldest);

				// Merge with existing messages
				const existingMessages: Memory[] =
					queryClient.getQueryData<Memory[]>([
						"messages",
						agentId,
						roomId,
						worldId,
					]) || [];

				// Create a Map with message ID as key to filter out any potential duplicates
				const messageMap = new Map<string, Memory>();

				// Add existing messages to the map
				existingMessages.forEach((msg: Memory): void => {
					messageMap.set(msg.id, msg);
				});

				// Add new messages to the map, overwriting any with the same ID
				response.memories.forEach((msg: Memory): void => {
					messageMap.set(msg.id, msg);
				});

				// Convert back to array and sort
				const mergedMessages: Memory[] = Array.from(messageMap.values());
				mergedMessages.sort(
					(a: Memory, b: Memory): number => a.createdAt - b.createdAt,
				);

				// Update the cache
				queryClient.setQueryData(
					["messages", agentId, roomId, worldId],
					mergedMessages,
				);

				// Update hasMoreMessages based on the number of messages received
				// If we received fewer messages than requested, we've likely reached the end
				setHasMoreMessages(response.memories.length >= 20);

				return true;
			}

			// No more messages to load
			setHasMoreMessages(false);
			return false;
		} catch (error: unknown) {
			console.error("Error loading older messages:", error);
			return false;
		} finally {
			setIsLoadingMore(false);
		}
	};

	return {
		...messagesQuery,
		loadOlderMessages,
		hasOlderMessages: hasMoreMessages,
		isLoadingMore,
	};
}
