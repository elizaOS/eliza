import { describe, it, expect, mock } from 'bun:test';
import { createService, defineService } from '../services';
import { Service } from '../types';
import type { IAgentRuntime } from '../types';

describe('service builder', () => {
  // Mock runtime
  const mockRuntime = {} as IAgentRuntime;

  it('createService builds custom class', async () => {
    const Builder = createService('TEST')
      .withDescription('d')
      .withStart(
        async () =>
          new (class extends Service {
            capabilityDescription = 'Test service';
            async stop() {}
          })()
      )
      .build();
    const instance = await (Builder as any).start(mockRuntime);
    expect(instance).toBeInstanceOf(Service);
    await instance.stop();
  });

  it('defineService builds from definition', async () => {
    const Def = defineService({
      serviceType: 'DEF' as any,
      description: 'desc',
      start: async () =>
        new (class extends Service {
          capabilityDescription = 'Definition service';
          async stop() {}
        })(),
    });
    const instance = await (Def as any).start(mockRuntime);
    expect(instance).toBeInstanceOf(Service);
    await instance.stop();
  });

  it('should throw error when start function is not defined', async () => {
    // This test covers lines 59-60 - error when startFn is not defined
    const Builder = createService('NO_START').withDescription('Service without start').build();

    await expect((Builder as any).start(mockRuntime)).rejects.toThrow(
      'Start function not defined for service NO_START'
    );
  });

  it('should call custom stop function when provided', async () => {
    // This test covers lines 65-68 - custom stopFn execution
    const stopFn = mock().mockResolvedValue(undefined);

    const Builder = createService('WITH_STOP')
      .withDescription('Service with custom stop')
      .withStart(
        async () =>
          new (class extends Service {
            capabilityDescription = 'Service with stop';
            async stop() {}
          })()
      )
      .withStop(stopFn)
      .build();

    await (Builder as any).start(mockRuntime);
    const builtInstance = new Builder();
    await builtInstance.stop();

    expect(stopFn).toHaveBeenCalled();
  });

  it('should handle service without stop function', async () => {
    // This test ensures the else branch (no stopFn) is covered
    const Builder = createService('NO_STOP')
      .withDescription('Service without custom stop')
      .withStart(
        async () =>
          new (class extends Service {
            capabilityDescription = 'Service without stop';
            async stop() {}
          })()
      )
      .build();

    const builtInstance = new Builder();
    // Should not throw when no stopFn is provided
    await expect(builtInstance.stop()).resolves.toBeUndefined();
  });

  it('defineService should provide default stop function', async () => {
    // This test covers the default stop function in defineService
    const Def = defineService({
      serviceType: 'DEF_NO_STOP' as any,
      description: 'Definition without stop',
      start: async () =>
        new (class extends Service {
          capabilityDescription = 'Definition without stop';
          async stop() {}
        })(),
      // Note: no stop function provided
    });

    await (Def as any).start(mockRuntime);
    const defInstance = new Def();
    // Should not throw when using default stop
    expect(defInstance.stop()).resolves.toBeUndefined();
  });

  it('should set all properties correctly with chaining', () => {
    // Test the full builder chain
    const description = 'Test service description';
    const serviceType = 'CHAINED_SERVICE';

    const builder = createService(serviceType);
    const withDesc = builder.withDescription(description);

    // Verify chaining returns the same instance
    expect(withDesc).toBe(builder);

    const startFn = async () =>
      new (class extends Service {
        capabilityDescription = 'Chained service';
        async stop() {}
      })();
    const withStart = withDesc.withStart(startFn);
    expect(withStart).toBe(builder);

    const stopFn = async () => {};
    const withStop = withStart.withStop(stopFn);
    expect(withStop).toBe(builder);

    const BuiltClass = withStop.build();
    expect((BuiltClass as any).serviceType).toBe(serviceType);
  });
});
