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
    expect(mockRuntime.registerEvent).toHaveBeenCalledWith('TASK_UPDATED', expect.any(Function));
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
    const processTaskMethod = (taskService as any).processTask.bind(taskService);

    // Call the method to check tasks
    await checkTasksMethod();

    // Should attempt to process the task
    expect(mockRuntime.useModel).toHaveBeenCalled();

    // Process the task directly to test that functionality
    await processTaskMethod(pastTask);

    // Verify task was processed correctly
    expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
      'TASK_PROCESSING',
      expect.objectContaining({
        taskId: pastTask.id,
      })
    );

    // Verify task was updated after processing
    expect(mockRuntime.updateTasks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: pastTask.id,
          status: 'COMPLETED',
        }),
      ])
    );
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

    // Mock the model to throw an error
    mockRuntime.useModel = vi.fn().mockRejectedValue(new Error('Task processing error'));

    // Expose the private method for testing
    const processTaskMethod = (taskService as any).processTask.bind(taskService);

    // Call the method to process the task
    await processTaskMethod(testTask);

    // Verify error was handled gracefully
    expect(mockRuntime.updateTasks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: testTask.id,
          status: 'ERROR',
        }),
      ])
    );

    // Should emit task error event
    expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
      'TASK_ERROR',
      expect.objectContaining({
        taskId: testTask.id,
        error: expect.objectContaining({
          message: 'Task processing error',
        }),
      })
    );
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
    services.forEach((service) => {
      expect(service).toHaveProperty('type');
      expect(service).toHaveProperty('name');
      expect(service).toHaveProperty('init');
      expect(typeof service.init).toBe('function');
    });
  });

  it('should initialize file service if available', async () => {
    const services = getPluginServices();
    const fileService = services.find((s) => s.type === 'file');

    if (fileService) {
      const serviceInstance = await fileService.init(mockRuntime as IAgentRuntime);

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
    const pdfService = services.find((s) => s.type === ServiceType.PDF);

    if (pdfService) {
      const serviceInstance = await pdfService.init(mockRuntime as IAgentRuntime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty('extractText');
      expect(typeof serviceInstance.extractText).toBe('function');
    }
  });

  it('should initialize image service if available', async () => {
    const services = getPluginServices();
    const imageService = services.find((s) => s.type === 'image');

    if (imageService) {
      const serviceInstance = await imageService.init(mockRuntime as IAgentRuntime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty('describeImage');
      expect(typeof serviceInstance.describeImage).toBe('function');
    }
  });

  it('should initialize browser service if available', async () => {
    const services = getPluginServices();
    const browserService = services.find((s) => s.type === ServiceType.BROWSER);

    if (browserService) {
      const serviceInstance = await browserService.init(mockRuntime as IAgentRuntime);

      expect(serviceInstance).toBeDefined();
      expect(serviceInstance).toHaveProperty('browse');
      expect(typeof serviceInstance.browse).toBe('function');
    }
  });

  it('should handle service initialization errors gracefully', async () => {
    const services = getPluginServices();
    const fileService = services.find((s) => s.type === 'file');

    if (fileService) {
      // Setup to force initialization error
      mockRuntime.getService = vi.fn().mockImplementation(() => {
        throw new Error('Service initialization failed');
      });

      // Should not throw but return a basic implementation
      const serviceInstance = await fileService.init(mockRuntime as IAgentRuntime);

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

describe('File Service Implementation', () => {
  let mockFileService: ReturnType<typeof createMockService>;
  let mockRuntime: MockRuntime;
  let fileService: any;

  beforeEach(async () => {
    // Create mock internal file service using standardized factory
    mockFileService = createMockService({
      name: 'mock-file-service',
      execute: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === 'uploadFile') {
          return Promise.resolve({
            id: 'file-1',
            filename: params.filename,
            contentType: params.contentType,
            size: 1024,
          });
        }
        if (method === 'getFile') {
          return Promise.resolve({
            id: params.id,
            filename: 'test-file.txt',
            contentType: 'text/plain',
            content: Buffer.from('File content'),
            size: 12,
          });
        }
        if (method === 'listFiles') {
          return Promise.resolve([
            { id: 'file-1', filename: 'file1.txt', contentType: 'text/plain', size: 100 },
            { id: 'file-2', filename: 'file2.jpg', contentType: 'image/jpeg', size: 1024 },
          ]);
        }
        if (method === 'deleteFile') {
          return Promise.resolve({ success: true });
        }
        return Promise.reject(new Error(`Unknown method: ${method}`));
      }),
    });

    // Create a mock runtime with custom service configuration
    mockRuntime = createMockRuntime({
      getService: vi.fn().mockReturnValue(mockFileService),
    });

    // Find and initialize the file service if available
    const services = getPluginServices();
    const bootstrapFileService = services.find((s) => s.type === 'file');
    if (bootstrapFileService) {
      fileService = await bootstrapFileService.init(mockRuntime as IAgentRuntime);
    }
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should upload files correctly', async () => {
    if (!fileService) {
      expect.fail('File service not initialized');
      return;
    }

    const testFile = {
      filename: 'test.txt',
      contentType: 'text/plain',
      content: Buffer.from('Test content'),
    };

    const result = await fileService.uploadFile(testFile);

    expect(result).toEqual({
      id: 'file-1',
      filename: 'test.txt',
      contentType: 'text/plain',
      size: 1024,
    });

    expect(mockFileService.execute).toHaveBeenCalledWith('uploadFile', testFile);
  });

  it('should retrieve files correctly', async () => {
    if (!fileService) {
      expect.fail('File service not initialized');
      return;
    }

    const result = await fileService.getFile({ id: 'file-1' });

    expect(result).toEqual({
      id: 'file-1',
      filename: 'test-file.txt',
      contentType: 'text/plain',
      content: expect.any(Buffer),
      size: 12,
    });

    expect(mockFileService.execute).toHaveBeenCalledWith('getFile', {
      id: 'file-1',
    });
  });

  it('should list files correctly', async () => {
    if (!fileService) {
      expect.fail('File service not initialized');
      return;
    }

    const result = await fileService.listFiles({});

    expect(result).toEqual([
      { id: 'file-1', filename: 'file1.txt', contentType: 'text/plain', size: 100 },
      { id: 'file-2', filename: 'file2.jpg', contentType: 'image/jpeg', size: 1024 },
    ]);

    expect(mockFileService.execute).toHaveBeenCalledWith('listFiles', {});
  });

  it('should delete files correctly', async () => {
    if (!fileService) {
      expect.fail('File service not initialized');
      return;
    }

    const result = await fileService.deleteFile({ id: 'file-1' });

    expect(result).toEqual({ success: true });

    expect(mockFileService.execute).toHaveBeenCalledWith('deleteFile', {
      id: 'file-1',
    });
  });

  it('should handle errors gracefully', async () => {
    if (!fileService) {
      expect.fail('File service not initialized');
      return;
    }

    // Simulate service error
    mockFileService.execute.mockRejectedValueOnce(new Error('Service unavailable'));

    // Method should not throw but return error
    const result = await fileService.uploadFile({
      filename: 'error.txt',
      contentType: 'text/plain',
      content: Buffer.from('Error content'),
    });

    // Verify the error is handled and returned in a consistent format
    expect(result).toHaveProperty('error');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('Service unavailable');
  });
});

describe('PDF Service Implementation', () => {
  let mockPdfService: ReturnType<typeof createMockService>;
  let mockRuntime: MockRuntime;
  let pdfService: any;

  beforeEach(async () => {
    // Create mock internal PDF service using standardized factory
    mockPdfService = createMockService({
      name: 'mock-pdf-service',
      execute: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === 'extractText') {
          return Promise.resolve({
            text: 'Extracted PDF text content',
            pages: 5,
          });
        }
        return Promise.reject(new Error(`Unknown method: ${method}`));
      }),
    });

    // Create a mock runtime with custom service configuration
    mockRuntime = createMockRuntime({
      getService: vi.fn().mockReturnValue(mockPdfService),
    });

    // Find and initialize the PDF service if available
    const services = getPluginServices();
    const bootstrapPdfService = services.find((s) => s.type === ServiceType.PDF);
    if (bootstrapPdfService) {
      pdfService = await bootstrapPdfService.init(mockRuntime as IAgentRuntime);
    }
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should extract text from PDFs correctly', async () => {
    if (!pdfService) {
      expect.fail('PDF service not initialized');
      return;
    }

    const result = await pdfService.extractText({
      fileId: 'pdf-1',
    });

    expect(result).toEqual({
      text: 'Extracted PDF text content',
      pages: 5,
    });

    expect(mockPdfService.execute).toHaveBeenCalledWith('extractText', {
      fileId: 'pdf-1',
    });
  });

  it('should handle errors gracefully', async () => {
    if (!pdfService) {
      expect.fail('PDF service not initialized');
      return;
    }

    // Simulate service error
    mockPdfService.execute.mockRejectedValueOnce(new Error('Invalid PDF format'));

    // Method should not throw but return error
    const result = await pdfService.extractText({
      fileId: 'invalid-pdf',
    });

    // Verify the error is handled and returned in a consistent format
    expect(result).toHaveProperty('error');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('Invalid PDF format');
  });
});

describe('Image Service Implementation', () => {
  let mockImageService: ReturnType<typeof createMockService>;
  let mockRuntime: MockRuntime;
  let imageService: any;

  beforeEach(async () => {
    // Create mock internal image service using standardized factory
    mockImageService = createMockService({
      name: 'mock-image-service',
      execute: vi.fn().mockImplementation((method: string, params: any) => {
        if (method === 'describeImage') {
          return Promise.resolve({
            description: 'An image showing a landscape with mountains and trees',
            tags: ['nature', 'mountains', 'trees'],
          });
        }
        return Promise.reject(new Error(`Unknown method: ${method}`));
      }),
    });

    // Create a mock runtime with custom service configuration
    mockRuntime = createMockRuntime({
      getService: vi.fn().mockReturnValue(mockImageService),
      useModel: vi.fn().mockImplementation((modelType, params) => {
        if (modelType === ModelType.IMAGE) {
          return Promise.resolve('A detailed description of the image');
        }
        return Promise.resolve('Generated text');
      }),
    });

    // Find and initialize the image service if available
    const services = getPluginServices();
    const bootstrapImageService = services.find((s) => s.type === 'image');
    if (bootstrapImageService) {
      imageService = await bootstrapImageService.init(mockRuntime as IAgentRuntime);
    }
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should describe images correctly using service', async () => {
    if (!imageService) {
      expect.fail('Image service not initialized');
      return;
    }

    const result = await imageService.describeImage({
      fileId: 'image-1',
    });

    expect(result).toEqual({
      description: 'An image showing a landscape with mountains and trees',
      tags: ['nature', 'mountains', 'trees'],
    });

    expect(mockImageService.execute).toHaveBeenCalledWith('describeImage', {
      fileId: 'image-1',
    });
  });

  it('should handle missing image service by using models', async () => {
    if (!imageService) {
      expect.fail('Image service not initialized');
      return;
    }

    // Create a new runtime with null service
    const newRuntime = createMockRuntime({
      getService: vi.fn().mockReturnValue(null),
      useModel: vi.fn().mockImplementation((modelType, params) => {
        if (modelType === ModelType.IMAGE) {
          return Promise.resolve('A detailed description of the image');
        }
        return Promise.resolve('Generated text');
      }),
    });

    // Re-initialize the image service with the new runtime
    const services = getPluginServices();
    const bootstrapImageService = services.find((s) => s.type === 'image');
    if (bootstrapImageService) {
      imageService = await bootstrapImageService.init(newRuntime as IAgentRuntime);
    }

    const result = await imageService.describeImage({
      fileId: 'image-2',
    });

    // Should use model fallback
    expect(newRuntime.useModel).toHaveBeenCalledWith(
      ModelType.IMAGE,
      expect.objectContaining({
        fileId: 'image-2',
      })
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty('description');
  });

  it('should handle errors gracefully', async () => {
    if (!imageService) {
      expect.fail('Image service not initialized');
      return;
    }

    // Simulate service error
    mockImageService.execute.mockRejectedValueOnce(new Error('Invalid image format'));

    // Method should not throw but return error
    const result = await imageService.describeImage({
      fileId: 'invalid-image',
    });

    // Verify the error is handled and returned in a consistent format
    expect(result).toHaveProperty('error');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('Invalid image format');
  });
});
