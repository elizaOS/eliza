// Extend the core service types with character management service
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    CHARACTER_MANAGEMENT: 'CHARACTER_MANAGEMENT';
  }
}

// Export service type constant
export const PersonalityServiceType = {
  CHARACTER_MANAGEMENT: 'CHARACTER_MANAGEMENT' as const,
} satisfies Partial<import('@elizaos/core').ServiceTypeRegistry>;
