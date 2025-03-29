import { describe, expect, it, vi, beforeEach, assert } from 'vitest';
import { StarterTestSuite } from '../src/tests';
import { v4 as uuidv4 } from 'uuid';

// Mock runtime
const createMockRuntime = () => {
  return {
    registerPlugin: vi.fn().mockResolvedValue(undefined),
    actions: [
      {
        name: 'HELLO_WORLD',
        handler: vi
          .fn()
          .mockImplementation(async (_runtime, _message, _state, _options, callback) => {
            await callback({
              text: 'hello world!',
              actions: ['HELLO_WORLD'],
            });
            return { text: 'hello world!', actions: ['HELLO_WORLD'] };
          }),
      },
    ],
    providers: [
      {
        name: 'HELLO_WORLD_PROVIDER',
        get: vi.fn().mockResolvedValue({
          text: 'I am a provider',
          values: {},
          data: {},
        }),
      },
    ],
    getService: vi.fn().mockReturnValue({
      capabilityDescription:
        'This is a starter service which is attached to the agent through the starter plugin.',
      stop: vi.fn(),
    }),
    processActions: vi.fn().mockImplementation(async (_message, _responses, _state, callback) => {
      await callback({
        text: 'hello world!',
        actions: ['HELLO_WORLD'],
      });
    }),
  };
};

vi.mock('uuid', () => ({
  v4: () => '00000000-0000-0000-0000-000000000000',
}));

describe('StarterTestSuite', () => {
  let testSuite: StarterTestSuite;

  beforeEach(() => {
    testSuite = new StarterTestSuite();
  });

  it('should have name and description', () => {
    expect(testSuite.name).toBe('starter');
    expect(testSuite.description).toBe('Tests for the starter project');
  });

  it('should have at least one test', () => {
    expect(testSuite.tests.length).toBeGreaterThan(0);
  });

  it('should run character configuration test successfully', async () => {
    const mockRuntime = createMockRuntime();
    const characterConfigTest = testSuite.tests.find(
      (test) => test.name === 'Character configuration test'
    );

    if (characterConfigTest) {
      // This test should pass without throwing an error
      await expect(characterConfigTest.fn(mockRuntime as any)).resolves.not.toThrow();
    } else {
      assert.fail('Character configuration test not found');
    }
  });

  it('should run plugin initialization test successfully', async () => {
    const mockRuntime = createMockRuntime();
    const pluginInitTest = testSuite.tests.find(
      (test) => test.name === 'Plugin initialization test'
    );

    if (pluginInitTest) {
      await expect(pluginInitTest.fn(mockRuntime as any)).resolves.not.toThrow();
      expect(mockRuntime.registerPlugin).toHaveBeenCalled();
    } else {
      assert.fail('Plugin initialization test not found');
    }
  });

  it('should run hello world action test successfully', async () => {
    const mockRuntime = createMockRuntime();
    const actionTest = testSuite.tests.find((test) => test.name === 'Hello world action test');

    if (actionTest) {
      await expect(actionTest.fn(mockRuntime as any)).resolves.not.toThrow();
      expect(mockRuntime.processActions).toHaveBeenCalled();
    } else {
      assert.fail('Hello world action test not found');
    }
  });

  it('should run hello world provider test successfully', async () => {
    const mockRuntime = createMockRuntime();
    const providerTest = testSuite.tests.find((test) => test.name === 'Hello world provider test');

    if (providerTest) {
      await expect(providerTest.fn(mockRuntime as any)).resolves.not.toThrow();
    } else {
      assert.fail('Hello world provider test not found');
    }
  });

  it('should run starter service test successfully', async () => {
    const mockRuntime = createMockRuntime();
    const serviceTest = testSuite.tests.find((test) => test.name === 'Starter service test');

    if (serviceTest) {
      await expect(serviceTest.fn(mockRuntime as any)).resolves.not.toThrow();
      expect(mockRuntime.getService).toHaveBeenCalledWith('starter');
    } else {
      assert.fail('Starter service test not found');
    }
  });
});
