import { describe, test, expect, beforeAll } from 'vitest';
import { googleGenAIPlugin } from '../src/index';

// Create a minimal mock runtime that satisfies the needs of our tests
const mockRuntime = {
  getSetting: (key: string) => process.env[key],
  character: {
    system: 'You are a helpful assistant.',
    name: 'Test Assistant',
    description: 'A test assistant',
    version: '1.0',
    actions: [],
    agentSettings: {},
    instructions: [],
  },
  emitEvent: () => {},
  agentId: 'test-agent',
  providers: {},
  actions: {},
  evaluators: {},
  hooks: {},
  settings: {},
  storage: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
  // Cast to unknown first, then to any to bypass strict type checking
  // This is acceptable for testing purposes
} as unknown as any;

describe('Google GenAI Plugin', () => {
  beforeAll(async () => {
    // Initialize plugin
    if (googleGenAIPlugin.init) {
      await googleGenAIPlugin.init({}, mockRuntime);
    }
  });

  describe('TEXT_SMALL Model', () => {
    test('should generate text with TEXT_SMALL model', async () => {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.warn('Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set');
        return;
      }

      const prompt = 'Hello, how are you today?';

      if (googleGenAIPlugin.models && googleGenAIPlugin.models['TEXT_SMALL']) {
        const textHandler = googleGenAIPlugin.models['TEXT_SMALL'];
        const response = await textHandler(mockRuntime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(0);
      } else {
        console.warn('TEXT_SMALL model not available');
      }
    }, 30000); // Increase timeout for API call
  });

  describe('TEXT_LARGE Model', () => {
    test('should generate text with TEXT_LARGE model', async () => {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.warn('Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set');
        return;
      }

      const prompt = 'Explain quantum computing in simple terms.';

      if (googleGenAIPlugin.models && googleGenAIPlugin.models['TEXT_LARGE']) {
        const textHandler = googleGenAIPlugin.models['TEXT_LARGE'];
        const response = await textHandler(mockRuntime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(0);
      } else {
        console.warn('TEXT_LARGE model not available');
      }
    }, 30000); // Increase timeout for API call
  });

  describe('TEXT_EMBEDDING Model', () => {
    test('should generate embeddings with TEXT_EMBEDDING model', async () => {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.warn('Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set');
        return;
      }

      const text = 'This is a test sentence for embedding.';

      if (googleGenAIPlugin.models && googleGenAIPlugin.models['TEXT_EMBEDDING']) {
        const embeddingHandler = googleGenAIPlugin.models['TEXT_EMBEDDING'];
        const response = await embeddingHandler(mockRuntime, { text });

        expect(response).toBeDefined();
        expect(Array.isArray(response)).toBe(true);
        expect(response.length).toBeGreaterThan(0);
        expect(typeof response[0]).toBe('number');
      } else {
        console.warn('TEXT_EMBEDDING model not available');
      }
    }, 30000); // Increase timeout for API call
  });

  describe('OBJECT_SMALL Model', () => {
    test('should generate JSON with OBJECT_SMALL model', async () => {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.warn('Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set');
        return;
      }

      const prompt = 'Create a JSON object representing a person with name, age, and hobbies.';

      if (googleGenAIPlugin.models && googleGenAIPlugin.models['OBJECT_SMALL']) {
        const objectHandler = googleGenAIPlugin.models['OBJECT_SMALL'];
        const response = await objectHandler(mockRuntime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe('object');
        expect(response).not.toBeNull();
      } else {
        console.warn('OBJECT_SMALL model not available');
      }
    }, 30000); // Increase timeout for API call
  });

  describe('OBJECT_LARGE Model', () => {
    test('should generate JSON with OBJECT_LARGE model', async () => {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.warn('Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set');
        return;
      }

      const prompt = 'Create a detailed JSON object representing a complex product catalog.';

      if (googleGenAIPlugin.models && googleGenAIPlugin.models['OBJECT_LARGE']) {
        const objectHandler = googleGenAIPlugin.models['OBJECT_LARGE'];
        const response = await objectHandler(mockRuntime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe('object');
        expect(response).not.toBeNull();
      } else {
        console.warn('OBJECT_LARGE model not available');
      }
    }, 50000); // Increase timeout for API call
  });

  describe('IMAGE_DESCRIPTION Model', () => {
    test('should describe an image with IMAGE_DESCRIPTION model', async () => {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.warn('Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set');
        return;
      }

      // Use a public domain test image
      const imageUrl =
        'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Gull_portrait_ca_usa.jpg/1280px-Gull_portrait_ca_usa.jpg';

      if (googleGenAIPlugin.models && googleGenAIPlugin.models['IMAGE_DESCRIPTION']) {
        const imageDescHandler = googleGenAIPlugin.models['IMAGE_DESCRIPTION'];
        const response = await imageDescHandler(mockRuntime, imageUrl);

        expect(response).toBeDefined();
        expect(response).toHaveProperty('title');
        expect(response).toHaveProperty('description');
        expect(typeof response.title).toBe('string');
        expect(typeof response.description).toBe('string');
        expect(response.title.length).toBeGreaterThan(0);
        expect(response.description.length).toBeGreaterThan(0);
      } else {
        console.warn('IMAGE_DESCRIPTION model not available');
      }
    }, 50000); // Increase timeout for API call

    test('should describe an image with custom prompt', async () => {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.warn('Skipping test: GOOGLE_GENERATIVE_AI_API_KEY not set');
        return;
      }

      // Use a public domain test image
      const imageUrl =
        'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Gull_portrait_ca_usa.jpg/1280px-Gull_portrait_ca_usa.jpg';
      const customPrompt =
        'Identify the species of bird in this image and provide detailed characteristics.';

      if (googleGenAIPlugin.models && googleGenAIPlugin.models['IMAGE_DESCRIPTION']) {
        const imageDescHandler = googleGenAIPlugin.models['IMAGE_DESCRIPTION'];
        const response = await imageDescHandler(mockRuntime, {
          imageUrl,
          prompt: customPrompt,
        });

        expect(response).toBeDefined();
        expect(response).toHaveProperty('title');
        expect(response).toHaveProperty('description');
        expect(typeof response.title).toBe('string');
        expect(typeof response.description).toBe('string');
        expect(response.title.length).toBeGreaterThan(0);
        expect(response.description.length).toBeGreaterThan(0);
      } else {
        console.warn('IMAGE_DESCRIPTION model not available');
      }
    }, 50000); // Increase timeout for API call
  });
});
