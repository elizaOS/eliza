import { describe, expect, it, mock } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { ngrokEnvSchema, validateNgrokConfig } from '../../environment';

type SettingMock = ((key: string) => unknown) & {
  mockImplementation: (implementation: (key: string) => unknown) => SettingMock;
  mockReturnValue: (value: unknown) => SettingMock;
};

type MockRuntimeWithSettings = IAgentRuntime & {
  getSetting: SettingMock;
};

interface NgrokConfigTestContext {
  mockRuntime: MockRuntimeWithSettings;
  originalEnv: NodeJS.ProcessEnv;
}

interface TestSuiteConfig<TContext> {
  beforeEach?: () => TContext;
  afterEach?: (context: TContext) => void | Promise<void>;
}

interface UnitTest<TContext> {
  name: string;
  fn: (context: TContext) => Promise<void> | void;
}

function createSettingMock(implementation: (key: string) => unknown): SettingMock {
  return mock(implementation) as SettingMock;
}

function createRuntimeWithSettingMock(
  implementation: (key: string) => unknown = () => undefined
): MockRuntimeWithSettings {
  return {
    getSetting: createSettingMock(implementation),
  } as MockRuntimeWithSettings;
}

// Simplified TestSuite implementation for local use
class TestSuite<TContext> {
  constructor(
    private name: string,
    private config: TestSuiteConfig<TContext>
  ) {}

  addTest(test: UnitTest<TContext>) {
    it(test.name, async () => {
      const context = this.config.beforeEach?.();
      if (!context) {
        throw new Error(`Missing test context for ${this.name}`);
      }
      await test.fn(context);
      await this.config.afterEach?.(context);
    });
  }

  run() {
    // No-op, bun:test handles execution
  }
}

const createUnitTest = (config: UnitTest<NgrokConfigTestContext>) => config;

describe('Ngrok Environment Configuration', () => {
  const ngrokConfigSuite = new TestSuite<NgrokConfigTestContext>(
    'Ngrok Environment Configuration',
    {
      beforeEach: () => {
        // Save original env
        const originalEnv = { ...process.env };

        // Clear relevant env vars
        delete process.env.NGROK_AUTH_TOKEN;
        delete process.env.NGROK_REGION;
        delete process.env.NGROK_SUBDOMAIN;
        delete process.env.NGROK_DEFAULT_PORT;

        // Setup mock runtime
        const mockRuntime = createRuntimeWithSettingMock((key: string) => {
          const settings: Record<string, string> = {};
          return settings[key];
        });

        return { mockRuntime, originalEnv };
      },
      afterEach: ({ originalEnv }) => {
        // Restore original env
        process.env = originalEnv;
      },
    }
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should accept valid configuration',
      fn: () => {
        const validConfig = {
          NGROK_AUTH_TOKEN: 'test-token',
          NGROK_REGION: 'eu',
          NGROK_SUBDOMAIN: 'my-subdomain',
          NGROK_DEFAULT_PORT: '8080',
        };

        const result = ngrokEnvSchema.parse(validConfig);

        expect(result.NGROK_AUTH_TOKEN).toBe('test-token');
        expect(result.NGROK_REGION).toBe('eu');
        expect(result.NGROK_SUBDOMAIN).toBe('my-subdomain');
        expect(result.NGROK_DEFAULT_PORT).toBe(8080);
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should use defaults for optional fields',
      fn: () => {
        const minimalConfig = {};

        const result = ngrokEnvSchema.parse(minimalConfig);

        expect(result.NGROK_AUTH_TOKEN).toBeUndefined();
        expect(result.NGROK_REGION).toBe('us');
        expect(result.NGROK_SUBDOMAIN).toBeUndefined();
        expect(result.NGROK_DEFAULT_PORT).toBe(3000);
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should transform port string to number',
      fn: () => {
        const config = {
          NGROK_DEFAULT_PORT: '5000',
        };

        const result = ngrokEnvSchema.parse(config);

        expect(result.NGROK_DEFAULT_PORT).toBe(5000);
        expect(typeof result.NGROK_DEFAULT_PORT).toBe('number');
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle empty port string',
      fn: () => {
        const config = {
          NGROK_DEFAULT_PORT: '',
        };

        const result = ngrokEnvSchema.parse(config);

        expect(result.NGROK_DEFAULT_PORT).toBe(3000); // Default
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should validate configuration from runtime settings',
      fn: async ({ mockRuntime }) => {
        mockRuntime.getSetting.mockImplementation((key: string) => {
          const settings: Record<string, string> = {
            NGROK_AUTH_TOKEN: 'runtime-token',
            NGROK_REGION: 'ap',
            NGROK_SUBDOMAIN: 'runtime-subdomain',
            NGROK_DEFAULT_PORT: '4000',
          };
          return settings[key];
        });

        const config = await validateNgrokConfig(mockRuntime);

        expect(config.NGROK_AUTH_TOKEN).toBe('runtime-token');
        expect(config.NGROK_REGION).toBe('ap');
        expect(config.NGROK_SUBDOMAIN).toBe('runtime-subdomain');
        expect(config.NGROK_DEFAULT_PORT).toBe(4000);
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should fall back to process.env if runtime setting is not available',
      fn: async ({ mockRuntime }) => {
        process.env.NGROK_AUTH_TOKEN = 'env-token';
        process.env.NGROK_REGION = 'sa';

        mockRuntime.getSetting.mockReturnValue(undefined);

        const config = await validateNgrokConfig(mockRuntime);

        expect(config.NGROK_AUTH_TOKEN).toBe('env-token');
        expect(config.NGROK_REGION).toBe('sa');
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should prefer runtime settings over process.env',
      fn: async ({ mockRuntime }) => {
        process.env.NGROK_AUTH_TOKEN = 'env-token';

        mockRuntime.getSetting.mockImplementation((key: string) => {
          if (key === 'NGROK_AUTH_TOKEN') {
            return 'runtime-token';
          }
          return undefined;
        });

        const config = await validateNgrokConfig(mockRuntime);

        expect(config.NGROK_AUTH_TOKEN).toBe('runtime-token');
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle validation errors gracefully',
      fn: async ({ mockRuntime }) => {
        // Mock invalid data that will fail zod validation - now NGROK_REGION accepts numbers
        mockRuntime.getSetting.mockImplementation((key: string) => {
          if (key === 'NGROK_DEFAULT_PORT') {
            return 'invalid-port'; // This will fail parsing
          }
          return undefined;
        });

        await expect(validateNgrokConfig(mockRuntime)).resolves.toEqual(
          expect.objectContaining({
            NGROK_DEFAULT_PORT: 3000, // Falls back to default on invalid input
          })
        );
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle number inputs by converting them',
      fn: async () => {
        const mockRuntime = createRuntimeWithSettingMock((key: string) => {
          const settings: Record<string, unknown> = {
            NGROK_REGION: 123, // Will be converted to '123'
            NGROK_DEFAULT_PORT: 'invalid', // Will use default 3000
          };
          return settings[key];
        });

        const config = await validateNgrokConfig(mockRuntime);
        expect(config.NGROK_REGION).toBe('123'); // Number converted to string
        expect(config.NGROK_DEFAULT_PORT).toBe(3000); // Invalid string uses default
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle all supported regions',
      fn: async ({ mockRuntime }) => {
        const regions = ['us', 'eu', 'ap', 'au', 'sa', 'jp', 'in'];

        for (const region of regions) {
          mockRuntime.getSetting.mockImplementation((key: string) => {
            if (key === 'NGROK_REGION') {
              return region;
            }
            return undefined;
          });

          const config = await validateNgrokConfig(mockRuntime);
          expect(config.NGROK_REGION).toBe(region);
        }
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle port zero',
      fn: async () => {
        const mockRuntime = createRuntimeWithSettingMock((key: string) => {
          const settings: Record<string, unknown> = {
            NGROK_DEFAULT_PORT: '0',
          };
          return settings[key];
        });

        const config = await validateNgrokConfig(mockRuntime);
        expect(config.NGROK_DEFAULT_PORT).toBe(3000); // Should use default instead of 0
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle very large port numbers',
      fn: async ({ mockRuntime }) => {
        mockRuntime.getSetting.mockImplementation((key: string) => {
          if (key === 'NGROK_DEFAULT_PORT') {
            return '65535';
          }
          return undefined;
        });

        const config = await validateNgrokConfig(mockRuntime);

        expect(config.NGROK_DEFAULT_PORT).toBe(65535);
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle null values from runtime settings',
      fn: async ({ mockRuntime }) => {
        mockRuntime.getSetting.mockReturnValue(null);

        const config = await validateNgrokConfig(mockRuntime);

        // Should use defaults
        expect(config.NGROK_AUTH_TOKEN).toBeUndefined();
        expect(config.NGROK_REGION).toBe('us');
        expect(config.NGROK_DEFAULT_PORT).toBe(3000);
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle undefined runtime',
      fn: async () => {
        const undefinedRuntime = createRuntimeWithSettingMock(() => undefined);

        const config = await validateNgrokConfig(undefinedRuntime);

        // Should use defaults
        expect(config.NGROK_REGION).toBe('us');
        expect(config.NGROK_DEFAULT_PORT).toBe(3000);
      },
    })
  );

  ngrokConfigSuite.run();
});
