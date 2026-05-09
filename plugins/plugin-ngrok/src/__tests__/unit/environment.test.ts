import { describe, expect, it, mock } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { ngrokEnvSchema, validateNgrokConfig } from '../../environment';

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

describe('Ngrok Environment Configuration', () => {
  const ngrokConfigSuite = new TestSuite('Ngrok Environment Configuration', {
    beforeEach: () => {
      // Save original env
      const originalEnv = { ...process.env };

      // Clear relevant env vars
      delete process.env.NGROK_AUTH_TOKEN;
      delete process.env.NGROK_REGION;
      delete process.env.NGROK_SUBDOMAIN;
      delete process.env.NGROK_DEFAULT_PORT;

      // Setup mock runtime
      const mockRuntime = {
        getSetting: mock((key: string) => {
          const settings: Record<string, string> = {};
          return settings[key];
        }),
      } as unknown as IAgentRuntime;

      return { mockRuntime, originalEnv };
    },
    afterEach: ({ originalEnv }: any) => {
      // Restore original env
      process.env = originalEnv;
    },
  });

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
      fn: async ({ mockRuntime }: any) => {
        (mockRuntime.getSetting as any).mockImplementation((key: string) => {
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
      fn: async ({ mockRuntime }: any) => {
        process.env.NGROK_AUTH_TOKEN = 'env-token';
        process.env.NGROK_REGION = 'sa';

        (mockRuntime.getSetting as any).mockReturnValue(undefined);

        const config = await validateNgrokConfig(mockRuntime);

        expect(config.NGROK_AUTH_TOKEN).toBe('env-token');
        expect(config.NGROK_REGION).toBe('sa');
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should prefer runtime settings over process.env',
      fn: async ({ mockRuntime }: any) => {
        process.env.NGROK_AUTH_TOKEN = 'env-token';

        (mockRuntime.getSetting as any).mockImplementation((key: string) => {
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
      fn: async ({ mockRuntime }: any) => {
        // Mock invalid data that will fail zod validation - now NGROK_REGION accepts numbers
        (mockRuntime.getSetting as any).mockImplementation((key: string) => {
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
        const mockRuntime = {
          getSetting: mock((key: string) => {
            const settings: Record<string, any> = {
              NGROK_REGION: 123, // Will be converted to '123'
              NGROK_DEFAULT_PORT: 'invalid', // Will use default 3000
            };
            return settings[key];
          }),
        } as unknown as IAgentRuntime;

        const config = await validateNgrokConfig(mockRuntime);
        expect(config.NGROK_REGION).toBe('123'); // Number converted to string
        expect(config.NGROK_DEFAULT_PORT).toBe(3000); // Invalid string uses default
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle all supported regions',
      fn: async ({ mockRuntime }: any) => {
        const regions = ['us', 'eu', 'ap', 'au', 'sa', 'jp', 'in'];

        for (const region of regions) {
          (mockRuntime.getSetting as any).mockImplementation((key: string) => {
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
        const mockRuntime = {
          getSetting: mock((key: string) => {
            const settings: Record<string, any> = {
              NGROK_DEFAULT_PORT: '0',
            };
            return settings[key];
          }),
        } as unknown as IAgentRuntime;

        const config = await validateNgrokConfig(mockRuntime);
        expect(config.NGROK_DEFAULT_PORT).toBe(3000); // Should use default instead of 0
      },
    })
  );

  ngrokConfigSuite.addTest(
    createUnitTest({
      name: 'should handle very large port numbers',
      fn: async ({ mockRuntime }: any) => {
        (mockRuntime.getSetting as any).mockImplementation((key: string) => {
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
      fn: async ({ mockRuntime }: any) => {
        (mockRuntime.getSetting as any).mockReturnValue(null as any);

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
        const undefinedRuntime = {
          getSetting: () => undefined,
        } as unknown as IAgentRuntime;

        const config = await validateNgrokConfig(undefinedRuntime);

        // Should use defaults
        expect(config.NGROK_REGION).toBe('us');
        expect(config.NGROK_DEFAULT_PORT).toBe(3000);
      },
    })
  );

  ngrokConfigSuite.run();
});
