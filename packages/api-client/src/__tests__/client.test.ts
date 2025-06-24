import { describe, it, expect } from 'bun:test';
import { ElizaClient } from '../client';
import { ApiClientConfig } from '../types/base';
import { AgentsService } from '../services/agents';
import { MessagingService } from '../services/messaging';
import { MemoryService } from '../services/memory';
import { AudioService } from '../services/audio';
import { MediaService } from '../services/media';
import { ServerService } from '../services/server';
import { SystemService } from '../services/system';

describe('ElizaClient', () => {
  const config: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  it('should create client with all services', () => {
    const client = new ElizaClient(config);

    expect(client.agents).toBeInstanceOf(AgentsService);
    expect(client.messaging).toBeInstanceOf(MessagingService);
    expect(client.memory).toBeInstanceOf(MemoryService);
    expect(client.audio).toBeInstanceOf(AudioService);
    expect(client.media).toBeInstanceOf(MediaService);
    expect(client.server).toBeInstanceOf(ServerService);
    expect(client.system).toBeInstanceOf(SystemService);
  });

  it('should create client using static create method', () => {
    const client = ElizaClient.create(config);

    expect(client).toBeInstanceOf(ElizaClient);
    expect(client.agents).toBeInstanceOf(AgentsService);
  });

  it('should pass config to all services', () => {
    const client = new ElizaClient(config);

    // Test that services are initialized with the same config
    // by checking they're defined (more detailed tests would check internals)
    expect(client.agents).toBeDefined();
    expect(client.messaging).toBeDefined();
    expect(client.memory).toBeDefined();
    expect(client.audio).toBeDefined();
    expect(client.media).toBeDefined();
    expect(client.server).toBeDefined();
    expect(client.system).toBeDefined();
  });
});
