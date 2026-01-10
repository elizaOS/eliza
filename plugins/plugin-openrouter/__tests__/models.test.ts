import { describe, test, expect, beforeAll } from 'bun:test';
import { openrouterPlugin } from '../src/index';

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

describe('OpenRouter Plugin', () => {
  beforeAll(async () => {
    // Initialize plugin
    if (openrouterPlugin.init) {
      await openrouterPlugin.init({}, mockRuntime);
    }
  });

  describe('TEXT_SMALL Model', () => {
    test('should generate text with TEXT_SMALL model', async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('Skipping test: OPENROUTER_API_KEY not set');
        return;
      }

      const prompt = 'Hello, how are you today?';

      if (openrouterPlugin.models && openrouterPlugin.models['TEXT_SMALL']) {
        const textHandler = openrouterPlugin.models['TEXT_SMALL'];
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
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('Skipping test: OPENROUTER_API_KEY not set');
        return;
      }

      const prompt = 'Explain quantum computing in simple terms.';

      if (openrouterPlugin.models && openrouterPlugin.models['TEXT_LARGE']) {
        const textHandler = openrouterPlugin.models['TEXT_LARGE'];
        const response = await textHandler(mockRuntime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(0);
      } else {
        console.warn('TEXT_LARGE model not available');
      }
    }, 30000); // Increase timeout for API call
  });

  describe('OBJECT_SMALL Model', () => {
    test('should generate JSON with OBJECT_SMALL model', async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('Skipping test: OPENROUTER_API_KEY not set');
        return;
      }

      const prompt = 'Create a JSON object representing a person with name, age, and hobbies.';

      if (openrouterPlugin.models && openrouterPlugin.models['OBJECT_SMALL']) {
        const objectHandler = openrouterPlugin.models['OBJECT_SMALL'];
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
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('Skipping test: OPENROUTER_API_KEY not set');
        return;
      }

      const prompt = 'Create a detailed JSON object representing a complex product catalog.';

      if (openrouterPlugin.models && openrouterPlugin.models['OBJECT_LARGE']) {
        const objectHandler = openrouterPlugin.models['OBJECT_LARGE'];
        const response = await objectHandler(mockRuntime, { prompt });

        expect(response).toBeDefined();
        expect(typeof response).toBe('object');
        expect(response).not.toBeNull();
      } else {
        console.warn('OBJECT_LARGE model not available');
      }
    }, 500000); // Increase timeout for API call
  });

  describe('IMAGE_DESCRIPTION Model', () => {
    test('should describe an image with IMAGE_DESCRIPTION model', async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('Skipping test: OPENROUTER_API_KEY not set');
        return;
      }

      // Use a public domain test image
      const imageUrl =
        'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Gull_portrait_ca_usa.jpg/1280px-Gull_portrait_ca_usa.jpg';

      if (openrouterPlugin.models && openrouterPlugin.models['IMAGE_DESCRIPTION']) {
        const imageDescHandler = openrouterPlugin.models['IMAGE_DESCRIPTION'];
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
    }, 500000); // Increase timeout for API call

    test('should describe an image with custom prompt', async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('Skipping test: OPENROUTER_API_KEY not set');
        return;
      }

      // Use a public domain test image
      const imageUrl =
        'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Gull_portrait_ca_usa.jpg/1280px-Gull_portrait_ca_usa.jpg';
      const customPrompt =
        'Identify the species of bird in this image and provide detailed characteristics.';

      if (openrouterPlugin.models && openrouterPlugin.models['IMAGE_DESCRIPTION']) {
        const imageDescHandler = openrouterPlugin.models['IMAGE_DESCRIPTION'];
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
    }, 500000); // Increase timeout for API call
  });

  describe('TEXT_EMBEDDING Model', () => {
    test('should generate embeddings with TEXT_EMBEDDING model', async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('Skipping test: OPENROUTER_API_KEY not set');
        return;
      }

      const text = 'Hello, this is a test for embeddings.';

      if (openrouterPlugin.models && openrouterPlugin.models['TEXT_EMBEDDING']) {
        const embeddingHandler = openrouterPlugin.models['TEXT_EMBEDDING'];
        const embedding = await embeddingHandler(mockRuntime, { text });

        expect(embedding).toBeDefined();
        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding.length).toBeGreaterThan(0);
        expect(typeof embedding[0]).toBe('number');
      } else {
        console.warn('TEXT_EMBEDDING model not available');
      }
    }, 30000); // Increase timeout for API call

    test('should handle string input for embeddings', async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('Skipping test: OPENROUTER_API_KEY not set');
        return;
      }

      const text = 'Testing string input for embeddings.';

      if (openrouterPlugin.models && openrouterPlugin.models['TEXT_EMBEDDING']) {
        const embeddingHandler = openrouterPlugin.models['TEXT_EMBEDDING'];
        const embedding = await embeddingHandler(mockRuntime, text);

        expect(embedding).toBeDefined();
        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding.length).toBeGreaterThan(0);
        expect(typeof embedding[0]).toBe('number');
      } else {
        console.warn('TEXT_EMBEDDING model not available');
      }
    }, 30000); // Increase timeout for API call

    test('should return test vector for null input', async () => {
      if (openrouterPlugin.models && openrouterPlugin.models['TEXT_EMBEDDING']) {
        const embeddingHandler = openrouterPlugin.models['TEXT_EMBEDDING'];
        const embedding = await embeddingHandler(mockRuntime, null);

        expect(embedding).toBeDefined();
        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding.length).toBeGreaterThan(0);
        expect(embedding[0]).toBe(0.1); // Test vector marker
      } else {
        console.warn('TEXT_EMBEDDING model not available');
      }
    });
  });
});
