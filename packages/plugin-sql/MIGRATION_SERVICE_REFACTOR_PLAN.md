# Migration Service Architecture Refactor Plan

## Current State

The current migration system has `runPluginMigrations` as a standalone function that's attached to the plugin object as a property. The `DatabaseMigrationService` is instantiated manually in the server and doesn't follow the standard ElizaOS service pattern.

## Proposed Architecture

### 1. Core Interfaces and Base Classes

#### IMigrationService Interface
```typescript
// packages/core/src/types/migration.ts
export interface IMigrationService {
  readonly serviceName: string;
  readonly serviceType: ServiceTypeName;
  
  // Core migration methods
  runMigrations(runtime: IAgentRuntime): Promise<void>;
  getMigrationHistory(): Promise<MigrationHistory[]>;
  rollback(version?: string): Promise<void>;
  
  // Plugin-specific methods
  registerPluginSchema(pluginName: string, schema: any): void;
  hasPluginMigrations(pluginName: string): boolean;
}

export interface MigrationHistory {
  id: string;
  pluginName: string;
  version: string;
  executedAt: Date;
  success: boolean;
  error?: string;
}
```

#### Base MigrationService Abstract Class
```typescript
// packages/core/src/services/migration-service.ts
export abstract class MigrationService extends Service implements IMigrationService {
  static serviceType = ServiceType.MIGRATION as ServiceTypeName;
  
  abstract runMigrations(runtime: IAgentRuntime): Promise<void>;
  abstract getMigrationHistory(): Promise<MigrationHistory[]>;
  abstract rollback(version?: string): Promise<void>;
  
  // Default implementations
  registerPluginSchema(pluginName: string, schema: any): void {
    // Base implementation for schema registration
  }
  
  hasPluginMigrations(pluginName: string): boolean {
    // Base implementation
    return false;
  }
}
```

### 2. SQL Plugin Migration Service

#### Refactored DatabaseMigrationService
```typescript
// packages/plugin-sql/src/services/database-migration-service.ts
export class DatabaseMigrationService extends MigrationService {
  static serviceName = 'database-migration' as ServiceTypeName;
  private db: DrizzleDatabase | null = null;
  private registeredSchemas = new Map<string, any>();
  private migrationHistory = new Map<string, MigrationHistory[]>();
  
  async initialize(runtime: IAgentRuntime): Promise<void> {
    const dbAdapter = runtime.getDatabaseAdapter();
    this.db = (dbAdapter as any).getDatabase();
    
    // Create migration history table if doesn't exist
    await this.ensureMigrationHistoryTable();
  }
  
  async runMigrations(runtime: IAgentRuntime): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    
    // Get all plugins with schemas
    const plugins = runtime.getPlugins();
    this.discoverAndRegisterPluginSchemas(plugins);
    
    // Run migrations for each registered schema
    for (const [pluginName, schema] of this.registeredSchemas) {
      await this.runPluginMigration(pluginName, schema);
    }
  }
  
  private async runPluginMigration(pluginName: string, schema: any): Promise<void> {
    try {
      // Check migration history
      const history = await this.getPluginMigrationHistory(pluginName);
      
      // Run the actual migration
      await runPluginMigrations(this.db!, pluginName, schema);
      
      // Record success
      await this.recordMigrationSuccess(pluginName);
    } catch (error) {
      // Record failure
      await this.recordMigrationFailure(pluginName, error);
      throw error;
    }
  }
  
  // ... other methods
}
```

### 3. Plugin-Specific Migration Service

```typescript
// packages/core/src/services/plugin-migration-service.ts
export abstract class PluginMigrationService extends MigrationService {
  protected pluginName: string;
  
  constructor(runtime: IAgentRuntime, pluginName: string) {
    super(runtime);
    this.pluginName = pluginName;
  }
  
  // Plugin-specific migration logic
  abstract migrateSchema(currentVersion: string, targetVersion: string): Promise<void>;
  abstract getSchemaVersion(): string;
}
```

### 4. Migration Orchestrator

```typescript
// packages/core/src/services/migration-orchestrator.ts
export class MigrationOrchestrator {
  private runtime: IAgentRuntime;
  
  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }
  
  async runAllMigrations(): Promise<void> {
    // Get all migration services
    const migrationServices = this.runtime.getServicesByType<IMigrationService>(
      ServiceType.MIGRATION as ServiceTypeName
    );
    
    // Sort by priority if needed
    const sortedServices = this.sortMigrationServices(migrationServices);
    
    // Run migrations in order
    for (const service of sortedServices) {
      logger.info(`Running migrations for service: ${service.serviceName}`);
      
      try {
        await service.runMigrations(this.runtime);
        logger.success(`Migrations completed for: ${service.serviceName}`);
      } catch (error) {
        logger.error(`Migration failed for ${service.serviceName}:`, error);
        throw error;
      }
    }
  }
  
  private sortMigrationServices(services: IMigrationService[]): IMigrationService[] {
    // Database migrations should run first
    return services.sort((a, b) => {
      if (a.serviceName === 'database-migration') return -1;
      if (b.serviceName === 'database-migration') return 1;
      return 0;
    });
  }
}
```

### 5. Updated Plugin Registration

```typescript
// packages/plugin-sql/src/index.ts
export const plugin: Plugin = {
  name: '@elizaos/plugin-sql',
  description: 'A plugin for SQL database access with dynamic schema migrations',
  priority: 0,
  
  // Register the migration service
  services: [DatabaseMigrationService],
  
  init: async (_, runtime: IAgentRuntime) => {
    // Standard database adapter initialization
    const dbAdapter = createDatabaseAdapter(...);
    runtime.registerDatabaseAdapter(dbAdapter);
    
    // Migration service will be automatically started by runtime
  },
  
  // Schema is still exposed for migration service to discover
  get schema() {
    return require('./schema');
  }
};
```

### 6. Updated Server Initialization

```typescript
// packages/server/src/index.ts
public async initialize(options?: ServerOptions): Promise<void> {
  // ... database initialization ...
  
  // Run migrations using the orchestrator
  logger.info('[INIT] Running database migrations...');
  try {
    const orchestrator = new MigrationOrchestrator(this);
    await orchestrator.runAllMigrations();
    logger.success('[INIT] All migrations completed successfully');
  } catch (error) {
    logger.error('[INIT] Migration failed:', error);
    throw error;
  }
  
  // ... rest of initialization ...
}
```

## Benefits

1. **Standardized Service Pattern**: Follows ElizaOS service architecture
2. **Plugin Autonomy**: Plugins can provide their own migration services
3. **Better Separation of Concerns**: Each plugin manages its own migrations
4. **Extensibility**: Easy to add new migration services
5. **Testability**: Services can be tested in isolation
6. **Migration History**: Built-in tracking of migration status
7. **Rollback Support**: Framework for implementing rollbacks

## Migration Path

1. Create core interfaces and base classes
2. Refactor existing DatabaseMigrationService
3. Update plugin-sql to register as a service
4. Create migration orchestrator
5. Update server initialization
6. Add comprehensive tests
7. Update documentation

## Example Plugin with Custom Migrations

```typescript
// Example: plugin-blockchain with custom migrations
class BlockchainMigrationService extends PluginMigrationService {
  static serviceName = 'blockchain-migration' as ServiceTypeName;
  
  async runMigrations(runtime: IAgentRuntime): Promise<void> {
    const currentVersion = await this.getCurrentVersion();
    const targetVersion = this.getSchemaVersion();
    
    if (currentVersion !== targetVersion) {
      await this.migrateSchema(currentVersion, targetVersion);
    }
  }
  
  async migrateSchema(currentVersion: string, targetVersion: string): Promise<void> {
    // Custom blockchain-specific migration logic
    // e.g., updating smart contracts, migrating on-chain data
  }
}

export const blockchainPlugin: Plugin = {
  name: '@elizaos/plugin-blockchain',
  services: [BlockchainMigrationService],
  // ...
};
```