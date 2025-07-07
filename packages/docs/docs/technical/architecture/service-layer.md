# Service Layer Architecture

ElizaOS implements a comprehensive service layer that provides modular, reusable functionality for agents. Services handle external integrations, background processing, and shared system resources while maintaining clean separation of concerns.

## Overview

The service layer provides:

1. **Modular Integration** - Pluggable services for different platforms and tools
2. **Lifecycle Management** - Proper initialization, startup, and shutdown handling
3. **Dependency Injection** - Type-safe service access throughout the runtime
4. **Background Processing** - Long-running tasks and scheduled operations

## Service Architecture

### Service Interface

```typescript
// packages/core/src/types/service.ts

interface Service {
  name: string;
  description?: string;
  initialize?: (runtime: IAgentRuntime) => Promise<void>;
  start?: (runtime: IAgentRuntime) => Promise<void>;
  stop?: (runtime: IAgentRuntime) => Promise<void>;
  [key: string]: any; // Additional service-specific methods and properties
}
```

### Service Type Registry

ElizaOS uses a type-safe service registry system:

```typescript
// Service type definitions
interface ServiceTypeRegistry {
  TRANSCRIPTION: 'transcription';
  VIDEO: 'video';
  BROWSER: 'browser';
  SPEECH: 'speech';
  IMAGE_RECOGNITION: 'image_recognition';
  PDF: 'pdf';
  // Extensible via module augmentation
}

type ServiceType = ServiceTypeRegistry[keyof ServiceTypeRegistry];
```

### Service Registration and Access

```typescript
// packages/core/src/runtime.ts

class AgentRuntime implements IAgentRuntime {
  private services = new Map<ServiceType, Service>();

  // Register a service with the runtime
  registerService(serviceType: ServiceType, service: Service): void {
    this.services.set(serviceType, service);
  }

  // Type-safe service access
  getService<T extends Service>(serviceType: ServiceType): T | null {
    return (this.services.get(serviceType) as T) || null;
  }

  // Get all registered services
  getServices(): Map<ServiceType, Service> {
    return new Map(this.services);
  }
}
```

## Built-in Services

### Transcription Service

Handles audio-to-text conversion:

```typescript
// packages/plugin-node/src/services/transcription.ts

interface TranscriptionService extends Service {
  transcribe(audioBuffer: Buffer, options?: TranscriptionOptions): Promise<string>;
  getSupportedFormats(): string[];
  isConfigured(): boolean;
}

class WhisperTranscriptionService implements TranscriptionService {
  name = 'whisper-transcription';
  description = 'OpenAI Whisper-based audio transcription';

  async initialize(runtime: IAgentRuntime): Promise<void> {
    // Initialize Whisper model or API client
    this.validateConfiguration();
  }

  async transcribe(audioBuffer: Buffer, options?: TranscriptionOptions): Promise<string> {
    try {
      // Convert audio buffer to format expected by Whisper
      const audioFile = await this.prepareAudioFile(audioBuffer);

      // Call Whisper API or local model
      const response = await this.callWhisperAPI(audioFile, options);

      return response.text;
    } catch (error) {
      console.error('Transcription failed:', error);
      throw new Error(`Transcription service error: ${error.message}`);
    }
  }

  getSupportedFormats(): string[] {
    return ['mp3', 'wav', 'ogg', 'm4a', 'webm'];
  }

  isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }
}
```

### Browser Service

Provides web browsing and content extraction:

```typescript
// packages/plugin-node/src/services/browser.ts

interface BrowserService extends Service {
  browse(url: string, options?: BrowseOptions): Promise<BrowseResult>;
  screenshot(url: string, options?: ScreenshotOptions): Promise<Buffer>;
  extractText(url: string): Promise<string>;
  close(): Promise<void>;
}

class PuppeteerBrowserService implements BrowserService {
  name = 'puppeteer-browser';
  description = 'Puppeteer-based web browsing service';

  private browser: Browser | null = null;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    // Launch browser instance
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  async browse(url: string, options: BrowseOptions = {}): Promise<BrowseResult> {
    if (!this.browser) {
      throw new Error('Browser service not initialized');
    }

    const page = await this.browser.newPage();

    try {
      // Configure page settings
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(options.userAgent || this.getDefaultUserAgent());

      // Navigate to URL
      const response = await page.goto(url, {
        waitUntil: options.waitUntil || 'domcontentloaded',
        timeout: options.timeout || 30000,
      });

      // Extract content based on options
      const result: BrowseResult = {
        url: page.url(),
        title: await page.title(),
        text: await this.extractPageText(page, options),
        html: options.includeHtml ? await page.content() : undefined,
        screenshot: options.screenshot ? await page.screenshot() : undefined,
        statusCode: response?.status(),
        links: options.extractLinks ? await this.extractLinks(page) : undefined,
      };

      return result;
    } finally {
      await page.close();
    }
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
```

### Speech Service

Handles text-to-speech conversion:

```typescript
// packages/plugin-node/src/services/speech.ts

interface SpeechService extends Service {
  speak(text: string, options?: SpeechOptions): Promise<Buffer>;
  getVoices(): Promise<Voice[]>;
  setVoice(voiceId: string): void;
}

class ElevenLabsSpeechService implements SpeechService {
  name = 'elevenlabs-speech';
  description = 'ElevenLabs text-to-speech service';

  private selectedVoice: string = 'default';

  async speak(text: string, options: SpeechOptions = {}): Promise<Buffer> {
    const voice = options.voice || this.selectedVoice;

    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        },
        body: JSON.stringify({
          text,
          model_id: options.model || 'eleven_monolingual_v1',
          voice_settings: {
            stability: options.stability || 0.5,
            similarity_boost: options.similarity_boost || 0.5,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Speech synthesis failed: ${response.statusText}`);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      console.error('Speech synthesis error:', error);
      throw error;
    }
  }

  async getVoices(): Promise<Voice[]> {
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
      },
    });

    const data = await response.json();
    return data.voices.map((voice: any) => ({
      id: voice.voice_id,
      name: voice.name,
      category: voice.category,
      description: voice.description,
    }));
  }
}
```

## Service Builder Pattern

ElizaOS provides a fluent builder API for creating services:

```typescript
// packages/core/src/service.ts

interface ServiceBuilder {
  withName(name: string): ServiceBuilder;
  withDescription(description: string): ServiceBuilder;
  withInitialize(fn: (runtime: IAgentRuntime) => Promise<void>): ServiceBuilder;
  withStart(fn: (runtime: IAgentRuntime) => Promise<void>): ServiceBuilder;
  withStop(fn: (runtime: IAgentRuntime) => Promise<void>): ServiceBuilder;
  withMethod(name: string, fn: Function): ServiceBuilder;
  build(): Service;
}

function createService(type: ServiceType): ServiceBuilder {
  const service: Partial<Service> = {};

  return {
    withName(name: string): ServiceBuilder {
      service.name = name;
      return this;
    },

    withDescription(description: string): ServiceBuilder {
      service.description = description;
      return this;
    },

    withInitialize(fn: (runtime: IAgentRuntime) => Promise<void>): ServiceBuilder {
      service.initialize = fn;
      return this;
    },

    withStart(fn: (runtime: IAgentRuntime) => Promise<void>): ServiceBuilder {
      service.start = fn;
      return this;
    },

    withStop(fn: (runtime: IAgentRuntime) => Promise<void>): ServiceBuilder {
      service.stop = fn;
      return this;
    },

    withMethod(name: string, fn: Function): ServiceBuilder {
      (service as any)[name] = fn;
      return this;
    },

    build(): Service {
      if (!service.name) {
        throw new Error('Service name is required');
      }
      return service as Service;
    },
  };
}

// Usage example
const customService = createService('custom')
  .withName('my-custom-service')
  .withDescription('A custom service for specific functionality')
  .withInitialize(async (runtime) => {
    console.log('Initializing custom service');
  })
  .withMethod('customMethod', async (data: any) => {
    return `Processed: ${data}`;
  })
  .build();
```

## Service Lifecycle Management

### Initialization Sequence

Services are initialized in a specific order during runtime startup:

```typescript
// packages/core/src/runtime.ts

class AgentRuntime {
  async initializeServices(): Promise<void> {
    const services = Array.from(this.services.entries());

    // Initialize services sequentially to handle dependencies
    for (const [serviceType, service] of services) {
      try {
        if (service.initialize) {
          console.log(`Initializing service: ${service.name}`);
          await service.initialize(this);
        }
      } catch (error) {
        console.error(`Failed to initialize service ${service.name}:`, error);
        // Decide whether to continue or fail fast based on service criticality
        if (this.isCriticalService(serviceType)) {
          throw error;
        }
      }
    }
  }

  async startServices(): Promise<void> {
    const services = Array.from(this.services.values());

    // Start services in parallel since they should be independent
    await Promise.allSettled(
      services.map(async (service) => {
        if (service.start) {
          try {
            console.log(`Starting service: ${service.name}`);
            await service.start(this);
          } catch (error) {
            console.error(`Failed to start service ${service.name}:`, error);
          }
        }
      })
    );
  }

  async stopServices(): Promise<void> {
    const services = Array.from(this.services.values());

    // Stop services in parallel for faster shutdown
    await Promise.allSettled(
      services.map(async (service) => {
        if (service.stop) {
          try {
            console.log(`Stopping service: ${service.name}`);
            await service.stop(this);
          } catch (error) {
            console.error(`Failed to stop service ${service.name}:`, error);
          }
        }
      })
    );
  }
}
```

### Health Monitoring

```typescript
interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastCheck: Date;
  error?: string;
  metrics?: {
    uptime: number;
    requestCount: number;
    errorRate: number;
    averageResponseTime: number;
  };
}

class ServiceHealthMonitor {
  private healthChecks = new Map<string, () => Promise<ServiceHealth>>();

  registerHealthCheck(serviceName: string, check: () => Promise<ServiceHealth>): void {
    this.healthChecks.set(serviceName, check);
  }

  async checkAllServices(): Promise<ServiceHealth[]> {
    const results: ServiceHealth[] = [];

    for (const [serviceName, check] of this.healthChecks) {
      try {
        const health = await check();
        results.push(health);
      } catch (error) {
        results.push({
          name: serviceName,
          status: 'unhealthy',
          lastCheck: new Date(),
          error: error.message,
        });
      }
    }

    return results;
  }

  async getServiceHealth(serviceName: string): Promise<ServiceHealth | null> {
    const check = this.healthChecks.get(serviceName);
    if (!check) return null;

    try {
      return await check();
    } catch (error) {
      return {
        name: serviceName,
        status: 'unhealthy',
        lastCheck: new Date(),
        error: error.message,
      };
    }
  }
}
```

## Service Integration Patterns

### Action-Service Integration

Services are commonly used within actions to provide functionality:

```typescript
// Example: Transcription action using transcription service
const transcribeAction: Action = {
  name: 'TRANSCRIBE_AUDIO',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // Check if message has audio attachment
    const hasAudio = message.content.attachments?.some((att) => att.type === 'audio');

    // Check if transcription service is available
    const transcriptionService = runtime.getService<TranscriptionService>('transcription');

    return hasAudio && transcriptionService?.isConfigured();
  },

  handler: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const transcriptionService = runtime.getService<TranscriptionService>('transcription');
    if (!transcriptionService) {
      throw new Error('Transcription service not available');
    }

    // Find audio attachment
    const audioAttachment = message.content.attachments?.find((att) => att.type === 'audio');

    if (!audioAttachment) {
      return false;
    }

    try {
      // Transcribe audio
      const transcription = await transcriptionService.transcribe(audioAttachment.data, {
        language: 'en',
      });

      // Store transcription as memory
      await runtime.memory.create({
        ...message,
        content: {
          text: transcription,
          metadata: {
            source: 'transcription',
            originalAudio: audioAttachment.id,
          },
        },
      });

      return true;
    } catch (error) {
      console.error('Transcription failed:', error);
      return false;
    }
  },
};
```

### Provider-Service Integration

Providers can use services to enhance state composition:

```typescript
// Example: Web content provider using browser service
const webContentProvider: Provider = {
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const browserService = runtime.getService<BrowserService>('browser');
    if (!browserService) {
      return null;
    }

    // Extract URLs from message
    const urls = extractUrls(message.content.text);
    if (urls.length === 0) {
      return null;
    }

    try {
      // Browse first URL and extract content
      const result = await browserService.browse(urls[0], {
        extractText: true,
        timeout: 10000,
      });

      return {
        text: `Web content from ${result.url}:\n${result.text}`,
        data: {
          webContent: {
            url: result.url,
            title: result.title,
            text: result.text,
          },
        },
      };
    } catch (error) {
      console.error('Failed to browse URL:', error);
      return null;
    }
  },
};
```

## Custom Service Development

### Creating a Custom Service

```typescript
// Example: Database cleanup service
interface DatabaseCleanupService extends Service {
  scheduleCleanup(interval: number): void;
  runCleanup(): Promise<void>;
  getCleanupStats(): CleanupStats;
}

class DatabaseCleanupServiceImpl implements DatabaseCleanupService {
  name = 'database-cleanup';
  description = 'Automated database maintenance and cleanup';

  private cleanupInterval: NodeJS.Timeout | null = null;
  private stats: CleanupStats = {
    lastRun: null,
    recordsDeleted: 0,
    spaceSaved: 0,
  };

  async initialize(runtime: IAgentRuntime): Promise<void> {
    console.log('Initializing database cleanup service');
    // Set up default cleanup schedule (daily)
    this.scheduleCleanup(24 * 60 * 60 * 1000);
  }

  async start(runtime: IAgentRuntime): Promise<void> {
    console.log('Database cleanup service started');
  }

  async stop(runtime: IAgentRuntime): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    console.log('Database cleanup service stopped');
  }

  scheduleCleanup(interval: number): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(async () => {
      try {
        await this.runCleanup();
      } catch (error) {
        console.error('Scheduled cleanup failed:', error);
      }
    }, interval);
  }

  async runCleanup(): Promise<void> {
    const startTime = Date.now();
    let deletedRecords = 0;

    try {
      // Clean up old memories (older than 30 days)
      const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      deletedRecords += await this.cleanupOldMemories(cutoffDate);

      // Clean up orphaned entities
      deletedRecords += await this.cleanupOrphanedEntities();

      // Clean up unused embeddings
      deletedRecords += await this.cleanupUnusedEmbeddings();

      // Update stats
      this.stats = {
        lastRun: new Date(),
        recordsDeleted: this.stats.recordsDeleted + deletedRecords,
        spaceSaved: this.estimateSpaceSaved(deletedRecords),
      };

      console.log(
        `Cleanup completed: ${deletedRecords} records deleted in ${Date.now() - startTime}ms`
      );
    } catch (error) {
      console.error('Database cleanup failed:', error);
      throw error;
    }
  }

  getCleanupStats(): CleanupStats {
    return { ...this.stats };
  }

  private async cleanupOldMemories(cutoffDate: Date): Promise<number> {
    // Implementation would depend on the database adapter
    // This is a simplified example
    return 0;
  }

  private async cleanupOrphanedEntities(): Promise<number> {
    return 0;
  }

  private async cleanupUnusedEmbeddings(): Promise<number> {
    return 0;
  }

  private estimateSpaceSaved(recordsDeleted: number): number {
    // Rough estimate: 1KB per record
    return recordsDeleted * 1024;
  }
}
```

### Service Registration in Plugins

```typescript
// Plugin that provides custom services
const cleanupPlugin: Plugin = {
  name: 'database-cleanup',
  description: 'Provides automated database maintenance',

  services: [
    {
      name: 'database-cleanup',
      service: new DatabaseCleanupServiceImpl(),
    },
  ],

  actions: [],
  evaluators: [],
  providers: [],
};

// Register plugin with runtime
runtime.registerPlugin(cleanupPlugin);

// Access the service
const cleanupService = runtime.getService<DatabaseCleanupService>('database-cleanup');
if (cleanupService) {
  await cleanupService.runCleanup();
}
```

## Error Handling and Resilience

### Service Circuit Breaker

```typescript
class ServiceCircuitBreaker {
  private failures = new Map<string, number>();
  private lastFailure = new Map<string, number>();
  private readonly threshold = 5;
  private readonly timeout = 60000; // 1 minute

  async execute<T>(serviceName: string, operation: () => Promise<T>): Promise<T> {
    const failures = this.failures.get(serviceName) || 0;
    const lastFailure = this.lastFailure.get(serviceName) || 0;

    // Check if circuit is open
    if (failures >= this.threshold) {
      if (Date.now() - lastFailure < this.timeout) {
        throw new Error(`Service ${serviceName} is temporarily unavailable`);
      }
      // Reset circuit after timeout
      this.failures.set(serviceName, 0);
    }

    try {
      const result = await operation();
      // Reset failures on success
      this.failures.set(serviceName, 0);
      return result;
    } catch (error) {
      // Track failure
      this.failures.set(serviceName, failures + 1);
      this.lastFailure.set(serviceName, Date.now());
      throw error;
    }
  }
}
```

### Service Retry Logic

```typescript
class ServiceRetryHandler {
  async withRetry<T>(
    operation: () => Promise<T>,
    options: {
      maxRetries?: number;
      delay?: number;
      backoff?: 'linear' | 'exponential';
    } = {}
  ): Promise<T> {
    const maxRetries = options.maxRetries || 3;
    const baseDelay = options.delay || 1000;
    const backoff = options.backoff || 'exponential';

    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt === maxRetries) {
          break;
        }

        // Calculate delay
        const delay =
          backoff === 'exponential' ? baseDelay * Math.pow(2, attempt) : baseDelay * (attempt + 1);

        console.log(
          `Operation failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
```

This service layer architecture provides ElizaOS with a robust, extensible foundation for integrating external systems and managing background operations while maintaining clean separation of concerns and proper lifecycle management.
