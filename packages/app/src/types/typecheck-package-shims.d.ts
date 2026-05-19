declare module "@elizaos/agent" {
  export interface ElizaConfig {
    [key: string]: unknown;
  }

  export type ReleaseChannel = string;
  export type RolesConfig = Record<string, unknown>;

  export const loadElizaConfig: (...args: unknown[]) => ElizaConfig;
  export const saveElizaConfig: (...args: unknown[]) => void;
  export const persistConfigEnv: (...args: unknown[]) => void;
  export const resolveStateDir: (...args: unknown[]) => string;
  export const createIntegrationTelemetrySpan: (...args: unknown[]) => unknown;
}
