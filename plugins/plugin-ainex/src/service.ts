// Placeholder service. Real implementation (W4.2) will own the
// AinexBridgeClient connection, expose the latest robot state / perception /
// policy status / battery snapshots to providers, and surface a camera frame
// stream for the robot camera source adapter (W4.3).

import {
  type IAgentRuntime,
  Service,
  type ServiceTypeName,
} from "@elizaos/core";
import { AinexBridgeClient } from "./bridge-client";

export class AinexService extends Service {
  static override serviceType: ServiceTypeName = "ainex" as ServiceTypeName;
  override capabilityDescription =
    "Drives a Hiwonder AiNex (or compatible) humanoid robot through the AiNex websocket bridge.";

  private bridge: AinexBridgeClient | null = null;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<AinexService> {
    return new AinexService(runtime);
  }

  getBridge(): AinexBridgeClient | null {
    return this.bridge;
  }

  async stop(): Promise<void> {
    if (this.bridge) {
      await this.bridge.disconnect().catch(() => {});
      this.bridge = null;
    }
  }
}
