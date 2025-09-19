import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Create mocks for all dependencies
const mockInstallPluginWithSpinner = mock();
const mockEnsureElizaDir = mock();
const mockSetupPgLite = mock();

// Mock the spinner utils - MUST be before any imports that use it
mock.module('@/src/utils/spinner-utils', () => ({
  installPluginWithSpinner: mockInstallPluginWithSpinner,
}));

// Mock the utils module with all required functions - MUST be before imports
mock.module('@/src/utils', () => ({
  ensureElizaDir: mockEnsureElizaDir,
  setupPgLite: mockSetupPgLite,
  promptAndStorePostgresUrl: mock(),
  promptAndStoreOpenAIKey: mock(),
  promptAndStoreAnthropicKey: mock(),
  promptAndStoreOllamaConfig: mock(),
  promptAndStoreOllamaEmbeddingConfig: mock(),
  promptAndStoreGoogleKey: mock(),
  promptAndStoreOpenRouterKey: mock(),
}));

// Mock file system operations - MUST be before imports
mock.module('node:fs', () => ({
  existsSync: mock(() => false),
}));

mock.module('node:fs/promises', () => ({
  readFile: mock(() => Promise.resolve('')),
  writeFile: mock(() => Promise.resolve()),
  mkdir: mock(() => Promise.resolve()),
}));

// Import SUT AFTER all mocks are registered
const { setupProjectEnvironment } = await import('@/src/commands/create/actions/setup');

describe('Ollama Plugin Installation', () => {
  beforeEach(() => {
    // Reset all mocks
    mockInstallPluginWithSpinner.mockReset();
    mockEnsureElizaDir.mockReset();
    mockSetupPgLite.mockReset();
  });

  it('should install Ollama plugin as fallback when using OpenAI', async () => {
    const targetDir = '/test/project';
    
    await setupProjectEnvironment(
      targetDir,
      'pglite',    // database
      'openai',    // aiModel
      undefined,   // embeddingModel
      true         // isNonInteractive
    );

    // Check that Ollama was installed as fallback
    const ollamaCall = mockInstallPluginWithSpinner.mock.calls.find(
      call => call[0] === 'ollama'
    );
    
    expect(ollamaCall).toBeDefined();
    expect(ollamaCall[1]).toBe(targetDir);
    expect(ollamaCall[2]).toBe('as universal fallback');
  });

  it('should install Ollama plugin as fallback when using Claude', async () => {
    const targetDir = '/test/project';
    
    await setupProjectEnvironment(
      targetDir,
      'pglite',
      'claude',    // aiModel
      undefined,
      true
    );

    const ollamaCall = mockInstallPluginWithSpinner.mock.calls.find(
      call => call[0] === 'ollama'
    );
    
    expect(ollamaCall).toBeDefined();
    expect(ollamaCall[2]).toBe('as universal fallback');
  });

  it('should NOT install Ollama plugin when local is selected as AI model', async () => {
    const targetDir = '/test/project';
    
    await setupProjectEnvironment(
      targetDir,
      'pglite',
      'local',     // aiModel (which is Ollama)
      undefined,
      true
    );

    // Ollama should be installed but NOT as fallback
    const ollamaFallbackCall = mockInstallPluginWithSpinner.mock.calls.find(
      call => call[0] === 'ollama' && call[2] === 'as universal fallback'
    );
    
    expect(ollamaFallbackCall).toBeUndefined();
  });

  it('should NOT install Ollama plugin when local is selected as embedding model', async () => {
    const targetDir = '/test/project';
    
    await setupProjectEnvironment(
      targetDir,
      'pglite',
      'openai',
      'local',     // embeddingModel (which is Ollama)
      true
    );

    // Ollama should be installed for embeddings but NOT as fallback
    const ollamaFallbackCall = mockInstallPluginWithSpinner.mock.calls.find(
      call => call[0] === 'ollama' && call[2] === 'as universal fallback'
    );
    
    expect(ollamaFallbackCall).toBeUndefined();
  });

  it('should install Ollama when using OpenRouter and OpenAI embeddings', async () => {
    const targetDir = '/test/project';
    
    await setupProjectEnvironment(
      targetDir,
      'postgres',
      'openrouter',
      'openai',
      true
    );

    const ollamaCall = mockInstallPluginWithSpinner.mock.calls.find(
      call => call[0] === 'ollama'
    );
    
    expect(ollamaCall).toBeDefined();
    expect(ollamaCall[2]).toBe('as universal fallback');
  });
});