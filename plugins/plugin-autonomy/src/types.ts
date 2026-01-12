import type { ServiceTypeRegistry, UUID } from '@elizaos/core';

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

/**
 * Status information for the autonomy service
 */
export interface AutonomyStatus {
  /** Whether autonomy is enabled in settings */
  enabled: boolean;
  /** Whether the autonomy loop is currently running */
  running: boolean;
  /** Whether an autonomous think cycle is currently in progress */
  thinking: boolean;
  /** Interval between autonomous thoughts in milliseconds */
  interval: number;
  /** ID of the dedicated autonomous room */
  autonomousRoomId: UUID;
}

/**
 * Configuration for autonomous operation
 */
export interface AutonomyConfig {
  /** Interval between autonomous thoughts in milliseconds (default: 30000) */
  intervalMs?: number;
  /** Auto-start autonomy when enabled in settings */
  autoStart?: boolean;
}
