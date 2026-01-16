import { Service, IAgentRuntime, logger } from '@elizaos/core';

export class OrcaService extends Service {
  private isRunning = false;

  static serviceType = 'ORCA_SERVICE';
  capabilityDescription = 'Provides Orca DEX integration for LP management';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    console.log('ORCA_SERVICE cstr');
  }

  static async start(runtime: IAgentRuntime) {
    console.log('ORCA_SERVICE trying to start');
    const service = new OrcaService(runtime);
    await service.start();
    return service;
  }

  async start() {
    console.log('ORCA_SERVICE trying to start');
  }

  async stop() {
    console.log('ORCA_SERVICE trying to stop');
  }
}
