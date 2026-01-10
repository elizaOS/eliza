// Extend the core service types with stagehand service
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    STAGEHAND: 'STAGEHAND';
  }
}

// Export service type constant
export const StagehandServiceType = {
  STAGEHAND: 'STAGEHAND' as const,
} satisfies Partial<import('@elizaos/core').ServiceTypeRegistry>;
