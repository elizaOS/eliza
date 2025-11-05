// Main client
export { ElizaClient } from './client';

// Base types
export * from './types/base';

// Domain types
export * from './types/agents';
export * from './types/messaging';
export * from './types/memory';
export * from './types/audio';
export * from './types/media';
export * from './types/server';
export * from './types/system';
export * from './types/sessions';
export * from './types/runs';
export * from './types/jobs';

// Services (for advanced usage)
export { AgentsService } from './services/agents';
export { MessagingService } from './services/messaging';
export { MemoryService } from './services/memory';
export { AudioService } from './services/audio';
export { MediaService } from './services/media';
export { ServerService } from './services/server';
export { SystemService } from './services/system';
export { SessionsService } from './services/sessions';
export { RunsService } from './services/runs';
export { JobsService } from './services/jobs';

// Base client and error
export { BaseApiClient, ApiError } from './lib/base-client';
