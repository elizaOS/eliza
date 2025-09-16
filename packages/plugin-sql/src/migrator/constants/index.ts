// Known composite primary keys for tables that don't have proper metadata
export const KNOWN_COMPOSITE_PRIMARY_KEYS: Record<string, { columns: string[] }> = {
  cache: { columns: ['key', 'agent_id'] },
  // Add other tables with composite primary keys here if needed
};
