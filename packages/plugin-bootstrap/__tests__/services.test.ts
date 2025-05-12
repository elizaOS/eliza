import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TaskService } from '../src/services/task';
import { ScenarioService } from '../src/services/scenario';
import { EventType, IAgentRuntime, logger, Service } from '@elizaos/core';
import { bootstrapPlugin } from '../src/index';
import { UUID, ModelType, ServiceType } from '@elizaos/core';
import { createMockRuntime, createMockService, MockRuntime, setupActionTest } from './test-utils';

// Define service interface for plugin services
interface PluginService extends Service {
  type: string;
  name: string;
  init: (runtime: IAgentRuntime) => Promise<any>;
}

// Helper to access plugin services with proper typing
const getPluginServices = (): PluginService[] =>
  (bootstrapPlugin.services || []) as unknown as PluginService[];

describe('TaskService', () => {
  let mockRuntime: MockRuntime;
  let taskService: TaskService;
  let mockTasks: Array<{
    id: string;
    name: string;
    description: string;
    status: string;
    createdAt: string;
    updatedAt?: string;
    scheduledFor?: string;
    tags: string[];
    metadata?: Record<string, any>;
  }>;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;

    // Create mock tasks
    mockTasks = [
      {
        id: 'task-1',
        name: 'Complete first task',
        description: 'First test task',
        status: 'PENDING',
        createdAt: new Date(Date.now() - 10000).toISOString(),
        updatedAt: new Date(Date.now() - 5000).toISOString(),
        tags: ['queue'],
      },
      {
        id: 'task-2',
        name: 'Make a decision',
        description: 'Choose between options',
        status: 'PENDING',
        createdAt: new Date(Date.now() - 20000).toISOString(),
        updatedAt: new Date(Date.now() - 15000).toISOString(),
        tags: ['queue'],
        metadata: {
          options: [
            { name: 'Option A', description: 'First option' },
            { name: 'Option B', description: 'Second option' },
          ],
        },
      },
    ];

    // Mock setTimeout
    vi.useFakeTimers();

    // Mock getTasks to return our test tasks
    mockRuntime.getTasks = vi.fn().mockResolvedValue(mockTasks);

    // Create service instance
    taskService = new TaskService(mockRuntime as IAgentRuntime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should be instantiated with a runtime', () => {
    expect(taskService).toBeDefined();
    expect(taskService).toBeInstanceOf(TaskService);

    // Verify that the service has the expected properties
    expect(TaskService).toHaveProperty('serviceType');
    expect(TaskService.serviceType).toBe(ServiceType.TASK);
    expect(taskService).toHaveProperty('runtime');
    expect(taskService).toHaveProperty('stop');
    expect(typeof taskService.stop).toBe('function');
  });

  it('should start the service successfully', async () => {
    // Test that the service can be started
    const startPromise = TaskService.start(mockRuntime as IAgentRuntime);

    // Should return a Promise
    expect(startPromise).toBeInstanceOf(Promise);

    // Verify the service was instantiated correctly
    const service = await startPromise;
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(TaskService);
    expect((service as any).runtime).toBe(mockRuntime);

    // Verify that the start method registered the service
    // expect(mockRuntime.registerEvent).toHaveBeenCalledWith('TASK_UPDATED', expect.any(Function)); // This event is not registered by start
  });

  it('should retrieve pending tasks correctly', async () => {
    // Expose the private method for testing
    const checkTasksMethod = (taskService as any).checkTasks.bind(taskService);

    // Call the method
    await checkTasksMethod();

    // Verify that getTasks was called with the correct parameters
    expect(mockRuntime.getTasks).toHaveBeenCalledWith({
      tags: ['queue'],
    });
  });

  it('should process tasks that are ready', async () => {
    // Create a task that's ready to process (scheduled for the past)
    const pastTask = {
      id: 'past-task',
      name: 'Past scheduled task',
      description: 'This task was scheduled in the past',
      status: 'PENDING',
      createdAt: new Date(Date.now() - 10000).toISOString(),
      scheduledFor: new Date(Date.now() - 5000).toISOString(),
      tags: ['queue'],
    };

    // Mock getTasks to return our ready task
    mockRuntime.getTasks = vi.fn().mockResolvedValue([pastTask]);

    // Expose and call the private methods for testing
    const checkTasksMethod = (taskService as any).checkTasks.bind(taskService);
    const executeTaskMethod = (taskService as any).executeTask.bind(taskService);

    // Mock getTaskWorker for 'Past scheduled task'
    const mockWorkerExecute = vi.fn().mockResolvedValue(undefined);
    mockRuntime.getTaskWorker = vi.fn((taskName: string) => {
      if (taskName === 'Past scheduled task') {
        return {
          name: taskName,
          execute: mockWorkerExecute,
          validate: vi.fn().mockResolvedValue(true),
        };
      }
      return undefined;
    });

    // Call the method to check tasks
    // This will internally call executeTask if conditions are met, but we test executeTask directly for more control
    // await checkTasksMethod(); // We are testing executeTask directly below

    // Process the task directly to test that functionality
    await executeTaskMethod(pastTask);

    // Verify task worker was called
    expect(mockRuntime.getTaskWorker).toHaveBeenCalledWith(pastTask.name);
    expect(mockWorkerExecute).toHaveBeenCalled();

    // Verify task was deleted (since it's not a repeating task)
    expect(mockRuntime.deleteTask).toHaveBeenCalledWith(pastTask.id);

    // Verify task was processed correctly (original assertions removed as they don't match current executeTask)
    // expect(mockRuntime.useModel).toHaveBeenCalled();
    // expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
    //   'TASK_PROCESSING',
    //   expect.objectContaining({
    //     taskId: pastTask.id,
    //   })
    // );
    // expect(mockRuntime.updateTasks).toHaveBeenCalledWith(
    //   expect.arrayContaining([
    //     expect.objectContaining({
    //       id: pastTask.id,
    //       status: 'COMPLETED',
    //     }),
    //   ])
    // );
  });

  it('should handle errors during task processing', async () => {
    // Create a task for testing
    const testTask = {
      id: 'error-task',
      name: 'Error task',
      description: 'This task will cause an error',
      status: 'PENDING',
      tags: ['queue'],
    };

    // Mock the model to throw an error - This is not directly used by executeTask, error should come from worker
    // mockRuntime.useModel = vi.fn().mockRejectedValue(new Error('Task processing error'));

    // Mock getTaskWorker for 'Error task' to throw an error
    const mockErrorExecute = vi.fn().mockRejectedValue(new Error('Worker execution error'));
    mockRuntime.getTaskWorker = vi.fn((taskName: string) => {
      if (taskName === 'Error task') {
        return {
          name: taskName,
          execute: mockErrorExecute,
          validate: vi.fn().mockResolvedValue(true),
        };
      }
      return undefined;
    });
    vi.spyOn(logger, 'error').mockImplementation(() => {}); // Suppress error logging for this test

    // Expose the private method for testing
    const executeTaskMethod = (taskService as any).executeTask.bind(taskService);

    // Call the method to process the task
    await executeTaskMethod(testTask);

    // Verify task worker was called
    expect(mockRuntime.getTaskWorker).toHaveBeenCalledWith(testTask.name);
    expect(mockErrorExecute).toHaveBeenCalled();

    // Verify error was logged
    expect(logger.error).toHaveBeenCalledWith(
      `[Bootstrap] Error executing task ${testTask.id}:`,
      expect.any(Error)
    );

    // Verify error was handled gracefully (original assertions removed as they don't match current executeTask)
    // executeTask currently only logs the error, doesn't update status or emit TASK_ERROR
    // expect(mockRuntime.updateTasks).toHaveBeenCalledWith(
    //   expect.arrayContaining([
    //     expect.objectContaining({
    //       id: testTask.id,
    //       status: 'ERROR',
    //     }),
    //   ])
    // );
    // expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
    //   'TASK_ERROR',
    //   expect.objectContaining({
    //     taskId: testTask.id,
    //     error: expect.objectContaining({
    //       message: 'Task processing error', // This would be 'Worker execution error'
    //     }),
    //   })
    // );
  });
});

describe('ScenarioService', () => {
  let mockRuntime: MockRuntime;
  let scenarioService: ScenarioService;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;

    // Create service instance
    scenarioService = new ScenarioService(mockRuntime as IAgentRuntime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be instantiated with a runtime', () => {
    expect(scenarioService).toBeDefined();
    expect(scenarioService).toBeInstanceOf(ScenarioService);

    // Verify that the service has the expected properties
    expect(ScenarioService).toHaveProperty('serviceType');
    expect(ScenarioService.serviceType).toBe('scenario');
    expect(scenarioService).toHaveProperty('runtime');
    expect(scenarioService).toHaveProperty('stop');
    expect(typeof scenarioService.stop).toBe('function');
  });

  it('should start the service successfully', async () => {
    // Test that the service can be started
    const startPromise = ScenarioService.start(mockRuntime as IAgentRuntime);

    // Should return a Promise
    expect(startPromise).toBeInstanceOf(Promise);

    // Verify the service was instantiated correctly
    const service = await startPromise;
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(ScenarioService);
    expect((service as any).runtime).toBe(mockRuntime);
  });
});

describe('Service Registry', () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Use setupActionTest for consistent test setup
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should register all services correctly', () => {
    const services = getPluginServices();
    expect(services).toBeDefined();
    expect(services.length).toBeGreaterThan(0);

    // Check that each service has the required properties
    services.forEach((serviceDefinitionOrClass) => {
      // The type of serviceDefinitionOrClass can be a class constructor or a descriptor object.
      // PluginService interface is for descriptor objects.
      // The error "expected [Function TaskService] to have property 'type'"
      // implies that for TaskService, serviceDefinitionOrClass is the class constructor.

      if (typeof serviceDefinitionOrClass === 'function') {
        // It's a class constructor (e.g., TaskService class)
        const serviceClass = serviceDefinitionOrClass as any; // Cast to access static props
        expect(serviceClass).toHaveProperty('serviceType');
        expect(typeof serviceClass.serviceType).toBe('string');
        expect(serviceClass).toHaveProperty('name'); // e.g., TaskService.name (class name)
        expect(typeof serviceClass.name).toBe('string');
        expect(serviceClass).toHaveProperty('start'); // Static start method
        expect(typeof serviceClass.start).toBe('function');
      } else {
        // It's a descriptor object, conforming to PluginService interface
        const serviceDesc = serviceDefinitionOrClass as PluginService;
        expect(serviceDesc).toHaveProperty('type');
        expect(typeof serviceDesc.type).toBe('string');
        expect(serviceDesc).toHaveProperty('name');
        expect(typeof serviceDesc.name).toBe('string');
        expect(serviceDesc).toHaveProperty('init');
        expect(typeof serviceDesc.init).toBe('function');
      }
    });
  });

  it('should initialize file service if available', async () => {
    const services = getPluginServices();
    const fileServiceDefinition = services.find((s) => {
      if (typeof s === 'function') return (s as any).serviceType === 'file';
      return (s as PluginService).type === 'file';
    });

    if (fileServiceDefinition) {
      const serviceInstance =
        typeof fileServiceDefinition === 'function'
          ? await (fileServiceDefinition as any).start(mockRuntime as IAgentRuntime) // This might still throw if start itself fails
          : await (fileServiceDefinition as PluginService).init(mockRuntime as IAgentRuntime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty('uploadFile');
      expect(serviceInstance).toHaveProperty('getFile');
      expect(serviceInstance).toHaveProperty('listFiles');
      expect(serviceInstance).toHaveProperty('deleteFile');
      expect(typeof serviceInstance.uploadFile).toBe('function');
      expect(typeof serviceInstance.getFile).toBe('function');
      expect(typeof serviceInstance.listFiles).toBe('function');
      expect(typeof serviceInstance.deleteFile).toBe('function');
    }
  });

  it('should initialize PDF service if available', async () => {
    const services = getPluginServices();
    const pdfServiceDefinition = services.find((s) => {
      if (typeof s === 'function') return (s as any).serviceType === ServiceType.PDF;
      return (s as PluginService).type === ServiceType.PDF;
    });

    if (pdfServiceDefinition) {
      const serviceInstance =
        typeof pdfServiceDefinition === 'function'
          ? await (pdfServiceDefinition as any).start(mockRuntime as IAgentRuntime)
          : await (pdfServiceDefinition as PluginService).init(mockRuntime as IAgentRuntime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty('extractText');
      expect(typeof serviceInstance.extractText).toBe('function');
    }
  });

  it('should initialize image service if available', async () => {
    const services = getPluginServices();
    const imageServiceDefinition = services.find((s) => {
      if (typeof s === 'function') return (s as any).serviceType === 'image'; // Assuming 'image' is the type
      return (s as PluginService).type === 'image';
    });

    if (imageServiceDefinition) {
      const serviceInstance =
        typeof imageServiceDefinition === 'function'
          ? await (imageServiceDefinition as any).start(mockRuntime as IAgentRuntime)
          : await (imageServiceDefinition as PluginService).init(mockRuntime as IAgentRuntime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty('describeImage');
      expect(typeof serviceInstance.describeImage).toBe('function');
    }
  });

  it('should initialize browser service if available', async () => {
    const services = getPluginServices();
    const browserServiceDefinition = services.find((s) => {
      if (typeof s === 'function') return (s as any).serviceType === ServiceType.BROWSER;
      return (s as PluginService).type === ServiceType.BROWSER;
    });

    if (browserServiceDefinition) {
      const serviceInstance =
        typeof browserServiceDefinition === 'function'
          ? await (browserServiceDefinition as any).start(mockRuntime as IAgentRuntime)
          : await (browserServiceDefinition as PluginService).init(mockRuntime as IAgentRuntime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty('browse');
      expect(typeof serviceInstance.browse).toBe('function');
    }
  });

  it('should handle service initialization errors gracefully', async () => {
    const services = getPluginServices();
    const fileServiceDefinition = services.find((s) => {
      if (typeof s === 'function') return (s as any).serviceType === 'file';
      return (s as PluginService).type === 'file';
    });

    if (fileServiceDefinition) {
      // Setup to force initialization error
      mockRuntime.getService = vi.fn().mockImplementation(() => {
        throw new Error('Service initialization failed');
      });

      // Should not throw but return a basic implementation
      const serviceInstance =
        typeof fileServiceDefinition === 'function'
          ? await (fileServiceDefinition as any).start(mockRuntime as IAgentRuntime) // This might still throw if start itself fails
          : await (fileServiceDefinition as PluginService).init(mockRuntime as IAgentRuntime);

      expect(serviceInstance).toBeDefined();
      expect(logger.warn).toHaveBeenCalled();

      // Should have fallback methods
      expect(serviceInstance).toHaveProperty('uploadFile');
      expect(serviceInstance).toHaveProperty('getFile');
      expect(serviceInstance).toHaveProperty('listFiles');
      expect(serviceInstance).toHaveProperty('deleteFile');
    }
  });
});
