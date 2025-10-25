/**
 * Constants for React Query stale times
 */
export const STALE_TIMES = {
    FREQUENT: 30000, // 30 seconds - for data that changes often
    STANDARD: 120000, // 2 minutes - default
    RARE: 600000, // 10 minutes - for rarely changing data
    NEVER: Number.POSITIVE_INFINITY, // Only refetch on explicit invalidation
} as const;

