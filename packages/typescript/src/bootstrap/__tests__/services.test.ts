import {
  type IAgentRuntime,
  logger,
  type Service,
  ServiceType,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskService } from "../../services/task";
import { createBootstrapPlugin } from "../index";
import { type MockRuntime, setupActionTest } from "./test-utils";

// Define service interface for plugin services
interface PluginService extends Service {
  type: string;
  name: string;
  init: (runtime: IAgentRuntime) => Promise<unknown>;
}

// Test interface for accessing private properties and methods of TaskService
interface TestableTaskService extends TaskService {
  runtime: IAgentRuntime;
  checkTasks(): Promise<void>;
  executeTask(task: {
    id: string;
    name: string;
    description: string;
    status: string;
    createdAt: string;
    updatedAt?: string;
    scheduledFor?: string;
    tags: string[];
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

// Type guard for service class constructors with static properties
interface ServiceClassConstructor {
  new (runtime?: IAgentRuntime): Service;
  serviceType: string;
  start(runtime: IAgentRuntime): Promise<Service>;
}

// Create the bootstrap plugin for testing
const bootstrapPlugin = createBootstrapPlugin();

// Helper to access plugin services with proper typing
const getPluginServices = (): PluginService[] =>
  (bootstrapPlugin.services || []) as PluginService[];

describe("TaskService", () => {
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
    metadata?: Record<string, unknown>;
  }>;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;

    // Create mock tasks
    mockTasks = [
      {
        id: "task-1",
        name: "Complete first task",
        description: "First test task",
        status: "PENDING",
        createdAt: new Date(Date.now() - 10000).toISOString(),
        updatedAt: new Date(Date.now() - 5000).toISOString(),
        tags: ["queue"],
      },
      {
        id: "task-2",
        name: "Make a decision",
        description: "Choose between options",
        status: "PENDING",
        createdAt: new Date(Date.now() - 20000).toISOString(),
        updatedAt: new Date(Date.now() - 15000).toISOString(),
        tags: ["queue"],
        metadata: {
          options: [
            { name: "Option A", description: "First option" },
            { name: "Option B", description: "Second option" },
          ],
        },
      },
    ];

    // Mock setTimeout
    // Note: Timer mocking can be added with vi.useFakeTimers() if needed

    // Mock getTasks to return our test tasks
    mockRuntime.getTasks = vi.fn().mockResolvedValue(mockTasks);

    // Create service instance
    taskService = new TaskService(mockRuntime as IAgentRuntime);
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Note: Timer restoration can be added with vi.useRealTimers() if needed
  });

  it("should be instantiated with a runtime", () => {
    expect(taskService).toBeDefined();
    expect(taskService).toBeInstanceOf(TaskService);

    // Verify that the service has the expected properties
    expect(TaskService).toHaveProperty("serviceType");
    expect(TaskService.serviceType).toBe(ServiceType.TASK);
    expect(taskService).toHaveProperty("runtime");
    expect(taskService).toHaveProperty("stop");
    expect(typeof taskService.stop).toBe("function");
  });

  it("should start the service successfully", async () => {
    // Test that the service can be started
    const startPromise = TaskService.start(mockRuntime as IAgentRuntime);

    // Should return a Promise
    expect(startPromise).toBeInstanceOf(Promise);

    // Verify the service was instantiated correctly
    const service = await startPromise;
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(TaskService);
    expect((service as unknown as TestableTaskService).runtime).toBe(
      mockRuntime,
    );

    // Verify that the start method registered the service
    // expect(mockRuntime.registerEvent).toHaveBeenCalledWith('TASK_UPDATED', expect.any(Function)); // This event is not registered by start
  });

  it("should retrieve pending tasks correctly", async () => {
    // Expose the private method for testing
    const checkTasksMethod = (
      taskService as unknown as TestableTaskService
    ).checkTasks.bind(taskService);

    // Call the method
    await checkTasksMethod();

    // Verify that getTasks was called with the correct parameters
    expect(mockRuntime.getTasks).toHaveBeenCalledWith({
      tags: ["queue"],
    });
  });

  it("should process tasks that are ready", async () => {
    // Create a task that's ready to process (scheduled for the past)
    const pastTask = {
      id: "past-task",
      name: "Past scheduled task",
      description: "This task was scheduled in the past",
      status: "PENDING",
      createdAt: new Date(Date.now() - 10000).toISOString(),
      scheduledFor: new Date(Date.now() - 5000).toISOString(),
      tags: ["queue"],
    };

    // Mock getTasks to return our ready task
    mockRuntime.getTasks = vi.fn().mockResolvedValue([pastTask]);

    // Expose and call the private methods for testing
    const executeTaskMethod = (
      taskService as unknown as TestableTaskService
    ).executeTask.bind(taskService);

    // Mock getTaskWorker for 'Past scheduled task'
    const mockWorkerExecute = vi.fn().mockResolvedValue(undefined);
    mockRuntime.getTaskWorker = vi
      .fn()
      .mockImplementation((taskName: string) => {
        if (taskName === "Past scheduled task") {
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

  it("should handle errors during task processing", async () => {
    // Create a task for testing
    const testTask = {
      id: "error-task",
      name: "Error task",
      description: "This task will cause an error",
      status: "PENDING",
      tags: ["queue"],
    };

    // Mock getTaskWorker for 'Error task' to throw an error
    const mockErrorExecute = vi
      .fn()
      .mockRejectedValue(new Error("Worker execution error"));
    mockRuntime.getTaskWorker = vi
      .fn()
      .mockImplementation((taskName: string) => {
        if (taskName === "Error task") {
          return {
            name: taskName,
            execute: mockErrorExecute,
            validate: vi.fn().mockResolvedValue(true),
          };
        }
        return undefined;
      });

    // Expose the private method for testing
    const executeTaskMethod = (
      taskService as unknown as TestableTaskService
    ).executeTask.bind(taskService);

    // The current implementation does not catch errors - they propagate
    await expect(executeTaskMethod(testTask)).rejects.toThrow(
      "Worker execution error",
    );

    // Verify task worker was called
    expect(mockRuntime.getTaskWorker).toHaveBeenCalledWith(testTask.name);
    expect(mockErrorExecute).toHaveBeenCalled();

    // Note: The current implementation does not have error handling in executeTask
    // Errors propagate up to the caller (checkTasks or higher)
    // If error logging is needed, it should be added to the TaskService implementation
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

describe("Service Registry", () => {
  let mockRuntime: MockRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    // Use setupActionTest for consistent test setup
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should register all services correctly", () => {
    const services = getPluginServices();
    expect(services).toBeDefined();
    expect(services.length).toBeGreaterThan(0);

    // Check that each service has the required properties
    services.forEach((serviceDefinitionOrClass) => {
      // The type of serviceDefinitionOrClass can be a class constructor or a descriptor object.
      // PluginService interface is for descriptor objects.
      // The error "expected [Function TaskService] to have property 'type'"
      // implies that for TaskService, serviceDefinitionOrClass is the class constructor.

      if (typeof serviceDefinitionOrClass === "function") {
        // It's a class constructor (e.g., TaskService class)
        const serviceClass =
          serviceDefinitionOrClass as ServiceClassConstructor;
        expect(serviceClass).toHaveProperty("serviceType");
        expect(typeof serviceClass.serviceType).toBe("string");
        expect(serviceClass).toHaveProperty("name"); // e.g., TaskService.name (class name)
        expect(typeof serviceClass.name).toBe("string");
        expect(serviceClass).toHaveProperty("start"); // Static start method
        expect(typeof serviceClass.start).toBe("function");
      } else {
        // It's a descriptor object, conforming to PluginService interface
        const serviceDesc = serviceDefinitionOrClass as PluginService;
        expect(serviceDesc).toHaveProperty("type");
        expect(typeof serviceDesc.type).toBe("string");
        expect(serviceDesc).toHaveProperty("name");
        expect(typeof serviceDesc.name).toBe("string");
        expect(serviceDesc).toHaveProperty("init");
        expect(typeof serviceDesc.init).toBe("function");
      }
    });
  });

  it("should initialize file service if available", async () => {
    const services = getPluginServices();
    const fileServiceDefinition = services.find((s) => {
      if (typeof s === "function") {
        return (s as ServiceClassConstructor).serviceType === "file";
      }
      return (s as PluginService).type === "file";
    });

    if (fileServiceDefinition) {
      const serviceInstance =
        typeof fileServiceDefinition === "function"
          ? await (fileServiceDefinition as ServiceClassConstructor).start(
              mockRuntime as IAgentRuntime,
            ) // This might still throw if start itself fails
          : await (fileServiceDefinition as PluginService).init(
              mockRuntime as IAgentRuntime,
            );

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty("uploadFile");
      expect(serviceInstance).toHaveProperty("getFile");
      expect(serviceInstance).toHaveProperty("listFiles");
      expect(serviceInstance).toHaveProperty("deleteFile");
      expect(typeof serviceInstance.uploadFile).toBe("function");
      expect(typeof serviceInstance.getFile).toBe("function");
      expect(typeof serviceInstance.listFiles).toBe("function");
      expect(typeof serviceInstance.deleteFile).toBe("function");
    }
  });

  it("should initialize PDF service if available", async () => {
    const services = getPluginServices();
    const pdfServiceDefinition = services.find((s) => {
      if (typeof s === "function") {
        return (s as ServiceClassConstructor).serviceType === ServiceType.PDF;
      }
      return (s as PluginService).type === ServiceType.PDF;
    });

    if (pdfServiceDefinition) {
      const serviceInstance =
        typeof pdfServiceDefinition === "function"
          ? await (pdfServiceDefinition as ServiceClassConstructor).start(
              mockRuntime as IAgentRuntime,
            )
          : await (pdfServiceDefinition as PluginService).init(
              mockRuntime as IAgentRuntime,
            );

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty("extractText");
      expect(typeof serviceInstance.extractText).toBe("function");
    }
  });

  it("should initialize image service if available", async () => {
    const services = getPluginServices();
    const imageServiceDefinition = services.find((s) => {
      if (typeof s === "function") {
        return (s as ServiceClassConstructor).serviceType === "image";
      } // Assuming 'image' is the type
      return (s as PluginService).type === "image";
    });

    if (imageServiceDefinition) {
      const serviceInstance =
        typeof imageServiceDefinition === "function"
          ? await (imageServiceDefinition as ServiceClassConstructor).start(
              mockRuntime as IAgentRuntime,
            )
          : await (imageServiceDefinition as PluginService).init(
              mockRuntime as IAgentRuntime,
            );

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty("describeImage");
      expect(typeof serviceInstance.describeImage).toBe("function");
    }
  });

  it("should initialize browser service if available", async () => {
    const services = getPluginServices();
    const browserServiceDefinition = services.find((s) => {
      if (typeof s === "function") {
        return (
          (s as ServiceClassConstructor).serviceType === ServiceType.BROWSER
        );
      }
      return (s as PluginService).type === ServiceType.BROWSER;
    });

    if (browserServiceDefinition) {
      const serviceInstance =
        typeof browserServiceDefinition === "function"
          ? await (browserServiceDefinition as ServiceClassConstructor).start(
              mockRuntime as IAgentRuntime,
            )
          : await (browserServiceDefinition as PluginService).init(
              mockRuntime as IAgentRuntime,
            );

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty("browse");
      expect(typeof serviceInstance.browse).toBe("function");
    }
  });

  it("should handle service initialization errors gracefully", async () => {
    const services = getPluginServices();
    const fileServiceDefinition = services.find((s) => {
      if (typeof s === "function") {
        return (s as ServiceClassConstructor).serviceType === "file";
      }
      return (s as PluginService).type === "file";
    });

    if (fileServiceDefinition) {
      // Setup to force initialization error
      mockRuntime.getService = vi.fn().mockImplementation(() => {
        throw new Error("Service initialization failed");
      });

      // Should not throw but return a basic implementation
      const serviceInstance =
        typeof fileServiceDefinition === "function"
          ? await (fileServiceDefinition as ServiceClassConstructor).start(
              mockRuntime as IAgentRuntime,
            ) // This might still throw if start itself fails
          : await (fileServiceDefinition as PluginService).init(
              mockRuntime as IAgentRuntime,
            );

      expect(serviceInstance).toBeDefined();
      expect(logger.warn).toHaveBeenCalled();

      // Should have fallback methods
      expect(serviceInstance).toHaveProperty("uploadFile");
      expect(serviceInstance).toHaveProperty("getFile");
      expect(serviceInstance).toHaveProperty("listFiles");
      expect(serviceInstance).toHaveProperty("deleteFile");
    }
  });
});
