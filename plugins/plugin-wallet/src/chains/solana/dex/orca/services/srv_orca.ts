import { type IAgentRuntime, Service } from "@elizaos/core";

export class OrcaService extends Service {
  [key: string]: unknown;

  static serviceType = "ORCA_SERVICE";
  capabilityDescription = "Provides standardized access to DEX liquidity pools." as const;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    console.log("ORCA_SERVICE cstr");
  }

  static async start(runtime: IAgentRuntime) {
    console.log("ORCA_SERVICE trying to start");
    const service = new OrcaService(runtime);
    await service.start();
    return service;
  }

  async start() {
    console.log("ORCA_SERVICE trying to start");
  }

  async stop() {
    console.log("ORCA_SERVICE trying to stop");
  }
}
