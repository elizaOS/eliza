import { spyOn, mock } from 'bun:test';
import { logger, type IAgentRuntime, type Memory, type State, type UUID } from '@elizaos/core';

/**
 * Create a mock runtime for testing
 */
export function createMockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    agentId: '00000000-0000-0000-0000-000000000001' as UUID,
    getSetting: mock((key: string) => {
      const settings: Record<string, unknown> = {
        SAM_SPEED: 72,
        SAM_PITCH: 64,
        SAM_THROAT: 128,
        SAM_MOUTH: 128,
      };
      return settings[key] || null;
    }),
    getService: mock(() => null),
    hasService: mock(() => false),
    registerService: mock(),
    initialize: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    evaluate: mock(() => Promise.resolve(null)),
    processActions: mock(() => Promise.resolve()),
    useModel: mock(() => Promise.resolve('test response')) as any,
    ensureConnection: mock(() => Promise.resolve()),
    composeState: mock(() => Promise.resolve({ data: {}, values: {}, text: '' } as State)),
    createMemory: mock(() => Promise.resolve('test-memory-id' as UUID)),
    actions: [],
    providers: [],
    evaluators: [],
    services: new Map(),
    db: null,
    plugins: [],
    routes: [],
    logger,
    character: {
      name: 'Test SAM Agent',
      id: '00000000-0000-0000-0000-000000000001' as UUID,
      username: 'test-sam-agent',
      bio: ['Retro voice synthesis agent'],
      settings: {},
      system: 'You are a helpful assistant with retro voice synthesis.',
      plugins: ['@elizaos/plugin-sam'],
    },
    ...overrides,
  } as IAgentRuntime;
}

/**
 * Set up logger spies for testing
 */
export function setupLoggerSpies() {
  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
  spyOn(logger, 'debug');
}

/**
 * Create a mock memory object for testing
 */
export function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: '00000000-0000-0000-0000-000000000002' as UUID,
    entityId: '00000000-0000-0000-0000-000000000003' as UUID,
    agentId: '00000000-0000-0000-0000-000000000001' as UUID,
    roomId: '00000000-0000-0000-0000-000000000004' as UUID,
    content: {
      text: 'test message',
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock state object for testing
 */
export function createMockState(overrides: Partial<State> = {}): State {
  return {
    data: {},
    values: {},
    text: '',
    ...overrides,
  };
}

/**
 * Create a mock audio buffer for testing
 */
export function createMockAudioBuffer(length: number = 1000): Uint8Array {
  const buffer = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
  return buffer;
}

/**
 * Create a mock WAV buffer with proper header
 */
export function createMockWAVBuffer(audioData: Uint8Array, sampleRate: number = 22050): Uint8Array {
  const wavHeaderSize = 44;
  const wavBuffer = new Uint8Array(wavHeaderSize + audioData.length);

  // WAV header
  const view = new DataView(wavBuffer.buffer, 0, wavHeaderSize);

  // RIFF header
  wavBuffer.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + audioData.length, true);
  wavBuffer.set(new TextEncoder().encode('WAVE'), 8);

  // fmt chunk
  wavBuffer.set(new TextEncoder().encode('fmt '), 12);
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // Byte rate
  view.setUint16(32, 1, true); // Block align
  view.setUint16(34, 8, true); // 8-bit samples

  // data chunk
  wavBuffer.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, audioData.length, true);

  // Audio data
  wavBuffer.set(audioData, wavHeaderSize);

  return wavBuffer;
}
