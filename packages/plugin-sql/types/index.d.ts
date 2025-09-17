import type { IDatabaseAdapter, UUID, Plugin } from '@elizaos/core';

export function createDatabaseAdapter(
  config: {
    dataDir?: string;
    postgresUrl?: string;
  },
  agentId: UUID
): IDatabaseAdapter;

export const plugin: Plugin;

export class DatabaseMigrationService {
  initializeWithDatabase(db: any): Promise<void>;
  discoverAndRegisterPluginSchemas(plugins: Plugin[]): void;
  runAllPluginMigrations(): Promise<void>;
}

export default plugin;
