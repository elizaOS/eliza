/**
 * Query key factories for elizacloud API.
 * Use these with useQuery / useMutation so cache invalidation stays consistent.
 */

export const elizacloudKeys = {
  all: ["elizacloud"] as const,
  // Example: list endpoints you’ll call and derive keys from them
  // chat: () => [...elizacloudKeys.all, "chat"] as const,
  // chatRoom: (roomId: string) => [...elizacloudKeys.all, "chat", roomId] as const,
  // user: (userId: string) => [...elizacloudKeys.all, "user", userId] as const,
};
