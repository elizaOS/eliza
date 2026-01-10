// Extend the core service types with SAM service
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    SAM_TTS: 'SAM_TTS';
  }
}

// Export service type constant
export const SAMServiceType = {
  SAM_TTS: 'SAM_TTS' as const,
} satisfies Partial<import('@elizaos/core').ServiceTypeRegistry>;
