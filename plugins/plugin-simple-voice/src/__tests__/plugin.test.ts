import { describe, expect, it, spyOn, beforeAll, afterAll } from 'bun:test';
import { samPlugin, SamTTSService } from '../index';
import { logger } from '@elizaos/core';
import dotenv from 'dotenv';

// Setup environment variables
dotenv.config();

// Need to spy on logger for documentation
beforeAll(() => {
  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
  spyOn(logger, 'debug');
});

afterAll(() => {
  // No global restore needed in bun:test
});

// Create a real runtime for testing
function createRealRuntime() {
  const services = new Map();

  // Create a real service instance if needed
  const createService = (serviceType: string) => {
    if (serviceType === SamTTSService.serviceType) {
      return new SamTTSService({
        character: {
          name: 'Test SAM Agent',
          system: 'You are a helpful assistant with retro voice synthesis.',
        },
      } as { character: { name: string; system: string } });
    }
    return null;
  };

  return {
    character: {
      name: 'Test SAM Agent',
      system: 'You are a helpful assistant with retro voice synthesis.',
      plugins: [],
      settings: {},
    },
    getSetting: (_key: string) => null,
    models: samPlugin.models,
    db: {
      get: async (_key: string) => null,
      set: async (_key: string, _value: unknown) => true,
      delete: async (_key: string) => true,
      getKeys: async (_pattern: string) => [],
    },
    getService: (serviceType: string) => {
      // Log the service request for debugging
      logger.debug(`Requesting service: ${serviceType}`);

      // Get from cache or create new
      if (!services.has(serviceType)) {
        logger.debug(`Creating new service: ${serviceType}`);
        services.set(serviceType, createService(serviceType));
      }

      return services.get(serviceType);
    },
    registerService: (serviceType: string, service: unknown) => {
      logger.debug(`Registering service: ${serviceType}`);
      services.set(serviceType, service);
    },
  };
}

describe('SAM Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(samPlugin.name).toBe('@elizaos/plugin-sam');
    expect(samPlugin.description).toContain('SAM Speech Synthesizer');
    expect(samPlugin.description).toContain('hardware bridge');
  });

  it('should have actions defined', () => {
    expect(samPlugin.actions).toBeDefined();
    expect(samPlugin.actions).toHaveLength(1);
    expect(samPlugin.actions![0].name).toBe('SAY_ALOUD');
  });

  it('should have services defined', () => {
    expect(samPlugin.services).toBeDefined();
    expect(samPlugin.services).toHaveLength(1);
    expect(samPlugin.services![0]).toBe(SamTTSService);
  });

  it('should initialize properly', async () => {
    // Initialize with config - using real runtime
    const runtime = createRealRuntime();

    if (samPlugin.init) {
      await samPlugin.init(
        {},
        runtime as { character: unknown; getSetting: (key: string) => null }
      );
      expect(true).toBe(true); // If we got here, init succeeded
    }
  });
});

describe('SAM Plugin Actions', () => {
  it('should have SAY_ALOUD action with correct structure', () => {
    const sayAloudAction = samPlugin.actions![0];

    expect(sayAloudAction.name).toBe('SAY_ALOUD');
    expect(sayAloudAction.description).toContain('SAM');
    expect(sayAloudAction.examples).toBeDefined();
    expect(sayAloudAction.validate).toBeDefined();
    expect(sayAloudAction.handler).toBeDefined();
    expect(typeof sayAloudAction.validate).toBe('function');
    expect(typeof sayAloudAction.handler).toBe('function');
  });

  it('should validate trigger words correctly', async () => {
    const sayAloudAction = samPlugin.actions![0];
    const runtime = createRealRuntime();

    // Test positive cases
    const triggerMessages = [
      { content: { text: 'say aloud hello world' } },
      { content: { text: 'please speak this text' } },
      { content: { text: 'can you say hello aloud?' } },
      { content: { text: 'voice: welcome to the future' } },
    ];

    for (const message of triggerMessages) {
      const isValid = await sayAloudAction.validate!(
        runtime as { character: unknown; getSetting: (key: string) => null },
        message as { content: { text: string } }
      );
      expect(isValid).toBe(true);
    }

    // Test negative cases
    const nonTriggerMessages = [
      { content: { text: 'hello world' } },
      { content: { text: 'what is the weather?' } },
      { content: { text: 'how are you today?' } },
    ];

    for (const message of nonTriggerMessages) {
      const isValid = await sayAloudAction.validate!(
        runtime as { character: unknown; getSetting: (key: string) => null },
        message as { content: { text: string } }
      );
      expect(isValid).toBe(false);
    }
  });
});

describe('SamTTSService', () => {
  it('should have correct service type', () => {
    expect(SamTTSService.serviceType).toBe('SAM_TTS');
  });

  it('should start the service', async () => {
    const runtime = createRealRuntime();
    const startResult = await SamTTSService.start(
      runtime as { character: unknown; getSetting: (key: string) => null }
    );

    expect(startResult).toBeDefined();
    expect(startResult.constructor.name).toBe('SamTTSService');

    // Test real functionality - check stop method is available
    expect(typeof startResult.stop).toBe('function');
    expect(typeof startResult.generateAudio).toBe('function');
    expect(typeof startResult.speakText).toBe('function');
  });

  it('should stop the service', async () => {
    const runtime = createRealRuntime();

    // Register a real service first
    const service = new SamTTSService(runtime);
    runtime.registerService(SamTTSService.serviceType, service);

    // Spy on the real service's stop method
    const stopSpy = spyOn(service, 'stop');

    // Call the service's stop method directly
    await service.stop();

    // Verify the service's stop method was called
    expect(stopSpy).toHaveBeenCalled();
  });

  it('should have capability description', () => {
    const runtime = createRealRuntime();
    const service = new SamTTSService(runtime);

    expect(service.capabilityDescription).toBeDefined();
    expect(service.capabilityDescription).toContain('SAM');
    expect(service.capabilityDescription).toContain('text-to-speech');
  });
});

describe('SAM Audio Generation', () => {
  it('should generate audio from text', async () => {
    const runtime = createRealRuntime();
    const service = new SamTTSService(runtime);

    const audioBuffer = await service.generateAudio('Hello test', {
      speed: 72,
      pitch: 64,
      throat: 128,
      mouth: 128,
    });

    expect(audioBuffer).toBeDefined();
    expect(audioBuffer.length).toBeGreaterThan(0);
  });

  it('should handle different voice parameters', async () => {
    const runtime = createRealRuntime();
    const service = new SamTTSService(runtime);

    const testCases = [
      { speed: 50, pitch: 40 },
      { speed: 100, pitch: 80 },
      { speed: 150, pitch: 120 },
    ];

    for (const params of testCases) {
      const audioBuffer = await service.generateAudio('Test voice', params);
      expect(audioBuffer).toBeDefined();
      expect(audioBuffer.length).toBeGreaterThan(0);
    }
  });

  it('should create WAV buffer from audio data', async () => {
    const runtime = createRealRuntime();
    const service = new SamTTSService(runtime);

    const audioBuffer = await service.generateAudio('WAV test');
    const wavBuffer = service.createWAVBuffer(audioBuffer, 22050);

    expect(wavBuffer).toBeDefined();
    expect(wavBuffer.length).toBeGreaterThan(audioBuffer.length); // WAV header adds bytes

    // Check for WAV header - convert bytes to string properly
    const headerBytes = Array.from(wavBuffer.subarray(0, 4));
    const headerString = String.fromCharCode(...headerBytes);
    expect(headerString).toBe('RIFF');
  });

  it('should handle empty text gracefully', async () => {
    const runtime = createRealRuntime();
    const service = new SamTTSService(runtime);

    const audioBuffer = await service.generateAudio('');
    expect(audioBuffer).toBeDefined();
    // Empty text might still generate some audio (silence or error sound)
  });

  it('should handle invalid parameters gracefully', async () => {
    const runtime = createRealRuntime();
    const service = new SamTTSService(runtime);

    // Test with extreme parameters
    const audioBuffer = await service.generateAudio('Test', {
      speed: -1, // Invalid speed
      pitch: 300, // Invalid pitch
      throat: -50, // Invalid throat
      mouth: 500, // Invalid mouth
    });

    expect(audioBuffer).toBeDefined();
    // SAM should handle invalid parameters gracefully
  });
});
