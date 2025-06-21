// Database migration logging configuration
export interface MigrationLogConfig {
  enableIntrospectorDebug: boolean;
  enableMigratorDebug: boolean;
  enableConstraintDebug: boolean;
  enableTableDebug: boolean;
}

export const migrationLogConfig: MigrationLogConfig = {
  // Set to true to enable verbose introspection logs
  enableIntrospectorDebug: false,
  // Set to true to enable verbose migration logs
  enableMigratorDebug: false,
  // Set to true to enable constraint debug logs
  enableConstraintDebug: false,
  // Set to true to enable table operation logs
  enableTableDebug: false,
};

// Helper function to check if debug logging is enabled
export function shouldLogDebug(category: keyof MigrationLogConfig): boolean {
  return migrationLogConfig[category] === true;
}