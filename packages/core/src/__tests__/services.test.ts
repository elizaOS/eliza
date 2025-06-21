import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createService, defineService } from '../services';
import { Service, ServiceType } from '../types';
import type { IAgentRuntime } from '../types';
import { AgentRuntime } from '../runtime';

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

describe('AgentRuntime v2 service methods', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    const mockAdapter = {
      init: vi.fn().mockResolvedValue(undefined),
      runMigrations: vi.fn().mockResolvedValue(undefined),
      ensureAgentExists: vi.fn().mockResolvedValue({ id: 'agent-123' }),
      getEntityById: vi.fn().mockResolvedValue(null),
      createEntity: vi.fn().mockResolvedValue(true),
      getRoom: vi.fn().mockResolvedValue(null),
      createRoom: vi.fn().mockResolvedValue('room-123'),
      getParticipantsForRoom: vi.fn().mockResolvedValue([]),
      addParticipant: vi.fn().mockResolvedValue(true),
      ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
    } as any;

    runtime = new AgentRuntime({
      character: { name: 'TestBot', bio: '' } as any,
      adapter: mockAdapter,
    });
  });

  it('getServicesByType should return all services of a given type', async () => {
    class WalletServiceA extends Service {
      static serviceName = 'WALLET_A';
      static serviceType = ServiceType.WALLET;
      capabilityDescription = 'd';
      static async start(runtime: IAgentRuntime) {
        return new this(runtime);
      }
      async stop() {}
    }
    class WalletServiceB extends Service {
      static serviceName = 'WALLET_B';
      static serviceType = ServiceType.WALLET;
      capabilityDescription = 'd';
      static async start(runtime: IAgentRuntime) {
        return new this(runtime);
      }
      async stop() {}
    }
    class TaskService extends Service {
      static serviceName = 'TASK_A';
      static serviceType = ServiceType.TASK;
      capabilityDescription = 'd';
      static async start(runtime: IAgentRuntime) {
        return new this(runtime);
      }
      async stop() {}
    }

    await runtime.registerService(WalletServiceA);
    await runtime.registerService(WalletServiceB);
    await runtime.registerService(TaskService);

    expect(runtime.getService('WALLET_A')).toBeInstanceOf(WalletServiceA);
    expect(runtime.getService('WALLET_B')).toBeInstanceOf(WalletServiceB);

    const walletServices = runtime.getServicesByType(ServiceType.WALLET);
    expect(walletServices).toHaveLength(2);
    expect(walletServices.some((s) => s instanceof WalletServiceA)).toBe(true);
    expect(walletServices.some((s) => s instanceof WalletServiceB)).toBe(true);

    const taskServices = runtime.getServicesByType(ServiceType.TASK);
    expect(taskServices).toHaveLength(1);
    expect(taskServices[0]).toBeInstanceOf(TaskService);
  });

  it('getServicesByType should return an empty array if no services match', async () => {
    class TaskServiceDef extends Service {
      static serviceName = 'TASK_A';
      static serviceType = ServiceType.TASK;
      capabilityDescription = 'd';
      static async start(runtime: IAgentRuntime) {
        return new this(runtime);
      }
      async stop() {}
    }

    await runtime.registerService(TaskServiceDef);
    const browserServices = runtime.getServicesByType(ServiceType.BROWSER);
    expect(browserServices).toHaveLength(0);
  });
});
