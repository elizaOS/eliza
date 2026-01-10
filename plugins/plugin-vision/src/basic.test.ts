import { describe, it, expect } from 'bun:test';
import { visionPlugin } from './index';

// Simplified TestSuite implementation for local use
class TestSuite {
  constructor(
    private name: string,
    private config: any
  ) {}

  addTest(test: any) {
    it(test.name, async () => {
      const context = this.config.beforeEach ? this.config.beforeEach() : {};
      await test.fn(context);
    });
  }

  run() {
    // No-op, bun:test handles execution
  }
}

const createUnitTest = (config: { name: string; fn: (context?: any) => Promise<void> | void }) =>
  config;

describe('Vision Plugin', () => {
  const visionPluginSuite = new TestSuite('Vision Plugin', {});

  visionPluginSuite.addTest(
    createUnitTest({
      name: 'should export a valid plugin',
      fn: () => {
        expect(visionPlugin).toBeDefined();
        expect(visionPlugin.name).toBe('vision');
        expect(visionPlugin.description).toBeDefined();
      },
    })
  );

  visionPluginSuite.addTest(
    createUnitTest({
      name: 'should have actions',
      fn: () => {
        expect(visionPlugin.actions).toBeDefined();
        expect(Array.isArray(visionPlugin.actions)).toBe(true);
      },
    })
  );

  visionPluginSuite.addTest(
    createUnitTest({
      name: 'should have providers',
      fn: () => {
        expect(visionPlugin.providers).toBeDefined();
        expect(Array.isArray(visionPlugin.providers)).toBe(true);
      },
    })
  );

  visionPluginSuite.run();
});
