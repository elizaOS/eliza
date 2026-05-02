import { TEST_DEFINITIONS } from '../shared/test-definitions';
import { TestDefinition } from '../types/action-bench-types';

export class ActionBenchLoader {
  private testDefinitions: Map<string, TestDefinition> = new Map();
  
  constructor() {
    this.loadTestDefinitions();
  }

  private loadTestDefinitions(): void {
    try {
      // Load from shared constants instead of file
      for (const test of TEST_DEFINITIONS.tests) {
        this.testDefinitions.set(test.testId, JSON.parse(JSON.stringify(test)) as TestDefinition);
      }
      
      console.log(`✅ Loaded ${TEST_DEFINITIONS.tests.length} action benchmark test definitions`);
    } catch (error) {
      console.error('❌ Failed to load test definitions:', error);
      throw error;
    }
  }

  getTestDefinition(testId: string): TestDefinition | null {
    return this.testDefinitions.get(testId) || null;
  }

  getAllTestDefinitions(): TestDefinition[] {
    return Array.from(this.testDefinitions.values());
  }

  getTestIds(): string[] {
    return Array.from(this.testDefinitions.keys());
  }
}
