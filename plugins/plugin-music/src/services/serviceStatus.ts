/**
 * Service status tracking for music info services
 */

export enum ServiceStatus {
  ACTIVE = "active",
  DEGRADED = "degraded", // Available but experiencing issues
  UNAVAILABLE = "unavailable",
  NOT_CONFIGURED = "not_configured",
}

export interface ServiceHealth {
  status: ServiceStatus;
  lastChecked: number;
  lastError?: string;
  responseTime?: number; // in milliseconds
}

export interface MusicInfoServiceStatus {
  musicBrainz: ServiceHealth;
  lastFm: ServiceHealth;
  genius: ServiceHealth;
  theAudioDb: ServiceHealth;
  wikipedia: ServiceHealth;
}
