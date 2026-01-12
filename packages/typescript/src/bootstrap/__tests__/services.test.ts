/**
 * @fileoverview Bootstrap Services Tests
 *
 * Tests for bootstrap services using REAL AgentRuntime instances.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.ts";
import { TaskService } from "../../services/task";
import type { IAgentRuntime, Service } from "../../types/index.ts";
import { ServiceType } from "../../types/index.ts";
import { createBootstrapPlugin } from "../index";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

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
  let runtime: IAgentRuntime;
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

  beforeEach(async () => {
    runtime = await createTestRuntime();

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

    vi.spyOn(runtime, "getTasks").mockResolvedValue(mockTasks as never);

    taskService = new TaskService(runtime);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should be instantiated with a runtime", () => {
    expect(taskService).toBeDefined();
    expect(taskService).toBeInstanceOf(TaskService);
    expect(TaskService).toHaveProperty("serviceType");
    expect(TaskService.serviceType).toBe(ServiceType.TASK);
    expect(taskService).toHaveProperty("runtime");
    expect(taskService).toHaveProperty("stop");
    expect(typeof taskService.stop).toBe("function");
  });

  it("should start the service successfully", async () => {
    const startPromise = TaskService.start(runtime);
    expect(startPromise).toBeInstanceOf(Promise);

    const service = await startPromise;
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(TaskService);
    expect((service as TestableTaskService).runtime).toBe(runtime);
  });

  it("should retrieve pending tasks correctly", async () => {
    const checkTasksMethod = (
      taskService as TestableTaskService
    ).checkTasks.bind(taskService);

    await checkTasksMethod();

    expect(runtime.getTasks).toHaveBeenCalledWith({
      tags: ["queue"],
    });
  });

  it("should process tasks that are ready", async () => {
    const pastTask = {
      id: "past-task",
      name: "Past scheduled task",
      description: "This task was scheduled in the past",
      status: "PENDING",
      createdAt: new Date(Date.now() - 10000).toISOString(),
      scheduledFor: new Date(Date.now() - 5000).toISOString(),
      tags: ["queue"],
    };

    vi.spyOn(runtime, "getTasks").mockResolvedValue([pastTask as never]);

    const executeTaskMethod = (
      taskService as TestableTaskService
    ).executeTask.bind(taskService);

    const mockWorkerExecute = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(runtime, "getTaskWorker").mockImplementation(
      (taskName: string) => {
        if (taskName === "Past scheduled task") {
          return {
            name: taskName,
            execute: mockWorkerExecute,
            validate: vi.fn().mockResolvedValue(true),
          };
        }
        return undefined;
      },
    );

    vi.spyOn(runtime, "deleteTask").mockResolvedValue(undefined);

    await executeTaskMethod(pastTask);

    expect(runtime.getTaskWorker).toHaveBeenCalledWith(pastTask.name);
    expect(mockWorkerExecute).toHaveBeenCalled();
    expect(runtime.deleteTask).toHaveBeenCalledWith(pastTask.id);
  });

  it("should handle errors during task processing", async () => {
    const testTask = {
      id: "error-task",
      name: "Error task",
      description: "This task will cause an error",
      status: "PENDING",
      tags: ["queue"],
    };

    const mockErrorExecute = vi
      .fn()
      .mockRejectedValue(new Error("Worker execution error"));
    vi.spyOn(runtime, "getTaskWorker").mockImplementation(
      (taskName: string) => {
        if (taskName === "Error task") {
          return {
            name: taskName,
            execute: mockErrorExecute,
            validate: vi.fn().mockResolvedValue(true),
          };
        }
        return undefined;
      },
    );

    const executeTaskMethod = (
      taskService as TestableTaskService
    ).executeTask.bind(taskService);

    await expect(executeTaskMethod(testTask)).rejects.toThrow(
      "Worker execution error",
    );

    expect(runtime.getTaskWorker).toHaveBeenCalledWith(testTask.name);
    expect(mockErrorExecute).toHaveBeenCalled();
  });
});

describe("Service Registry", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should register all services correctly", () => {
    const services = getPluginServices();
    expect(services).toBeDefined();
    expect(services.length).toBeGreaterThan(0);

    services.forEach((serviceDefinitionOrClass) => {
      if (typeof serviceDefinitionOrClass === "function") {
        const serviceClass =
          serviceDefinitionOrClass as ServiceClassConstructor;
        expect(serviceClass).toHaveProperty("serviceType");
        expect(typeof serviceClass.serviceType).toBe("string");
        expect(serviceClass).toHaveProperty("name");
        expect(typeof serviceClass.name).toBe("string");
        expect(serviceClass).toHaveProperty("start");
        expect(typeof serviceClass.start).toBe("function");
      } else {
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
              runtime,
            )
          : await (fileServiceDefinition as PluginService).init(runtime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty("uploadFile");
      expect(serviceInstance).toHaveProperty("getFile");
      expect(serviceInstance).toHaveProperty("listFiles");
      expect(serviceInstance).toHaveProperty("deleteFile");
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
              runtime,
            )
          : await (pdfServiceDefinition as PluginService).init(runtime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty("extractText");
    }
  });

  it("should initialize image service if available", async () => {
    const services = getPluginServices();
    const imageServiceDefinition = services.find((s) => {
      if (typeof s === "function") {
        return (s as ServiceClassConstructor).serviceType === "image";
      }
      return (s as PluginService).type === "image";
    });

    if (imageServiceDefinition) {
      const serviceInstance =
        typeof imageServiceDefinition === "function"
          ? await (imageServiceDefinition as ServiceClassConstructor).start(
              runtime,
            )
          : await (imageServiceDefinition as PluginService).init(runtime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty("describeImage");
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
              runtime,
            )
          : await (browserServiceDefinition as PluginService).init(runtime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty("browse");
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
      vi.spyOn(runtime, "getService").mockImplementation(() => {
        throw new Error("Service initialization failed");
      });

      const serviceInstance =
        typeof fileServiceDefinition === "function"
          ? await (fileServiceDefinition as ServiceClassConstructor).start(
              runtime,
            )
          : await (fileServiceDefinition as PluginService).init(runtime);

      expect(serviceInstance).toBeDefined();
      expect(logger.warn).toHaveBeenCalled();
      expect(serviceInstance).toHaveProperty("uploadFile");
      expect(serviceInstance).toHaveProperty("getFile");
      expect(serviceInstance).toHaveProperty("listFiles");
      expect(serviceInstance).toHaveProperty("deleteFile");
    }
  });
});
