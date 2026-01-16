import type { ServiceTypeRegistry } from '@elizaos/core';

// Extend the core service types with autonomous service
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    AUTONOMOUS: 'AUTONOMOUS';
  }
}

// Export service type constant
export const AutonomousServiceType = {
  AUTONOMOUS: 'AUTONOMOUS' as const,
} satisfies Partial<ServiceTypeRegistry>;
