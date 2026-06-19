/**
 * Shared "config-like" structural interfaces.
 *
 * These are lightweight structural types used by multiple API route modules
 * to type-narrow the runtime config without importing the full schema.
 */

export interface CloudProxyConfigLike {
  cloud?: {
    apiKey?: string;
    baseUrl?: string;
    serviceKey?: string;
  };
}

export interface AutonomousConfigLike {
  [key: string]: unknown;
}
