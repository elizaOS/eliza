import { ApiClientConfig } from './types/base';
import { AgentsService } from './services/agents';
import { MessagingService } from './services/messaging';
import { MemoryService } from './services/memory';
import { AudioService } from './services/audio';
import { MediaService } from './services/media';
import { ServerService } from './services/server';
import { SystemService } from './services/system';

export class ElizaClient {
  public readonly agents: AgentsService;
  public readonly messaging: MessagingService;
  public readonly memory: MemoryService;
  public readonly audio: AudioService;
  public readonly media: MediaService;
  public readonly server: ServerService;
  public readonly system: SystemService;

  constructor(config: ApiClientConfig) {
    // Initialize all services with the same config
    this.agents = new AgentsService(config);
    this.messaging = new MessagingService(config);
    this.memory = new MemoryService(config);
    this.audio = new AudioService(config);
    this.media = new MediaService(config);
    this.server = new ServerService(config);
    this.system = new SystemService(config);
  }

  /**
   * Create a new ElizaClient instance
   */
  static create(config: ApiClientConfig): ElizaClient {
    return new ElizaClient(config);
  }
}
