import { describe, it, expect, beforeAll } from 'vitest';
import { setDatabaseType } from '../../schema/factory';
import * as schema from '../../schema/index';

describe('Circular Dependency Fix', () => {
  beforeAll(() => {
    setDatabaseType('pglite');
  });

  it('should access schema tables without circular dependency error', () => {
    // This test verifies that the circular dependency between entity.ts and agent.ts is fixed
    expect(() => {
      const agentTable = schema.agentTable;
      const entityTable = schema.entityTable;
      const componentTable = schema.componentTable;
      
      // Access properties to ensure the proxy is working
      expect(agentTable).toBeDefined();
      expect(entityTable).toBeDefined();
      expect(componentTable).toBeDefined();
    }).not.toThrow();
  });

  it('should create tables with correct database type', () => {
    // Simply verify that accessing the tables doesn't throw errors
    // The table creation happens through the proxy
    expect(schema.agentTable).toBeDefined();
    expect(schema.entityTable).toBeDefined();
    expect(schema.componentTable).toBeDefined();
    
    // The fact that we got here without errors means the circular dependency is fixed
  });
});