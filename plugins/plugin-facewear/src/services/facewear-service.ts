import type { IAgentRuntime } from "@elizaos/core";
import { Service } from "@elizaos/core";
import type { SmartglassesService } from "./smartglasses-service.ts";
import { SMARTGLASSES_SERVICE_NAME } from "./smartglasses-service.ts";
import {
  XR_SERVICE_TYPE,
  type XRConnection,
  type XRSessionService,
} from "./xr-session-service.ts";

export const FACEWEAR_SERVICE_TYPE = "facewear";

export type FacewearActiveDevice =
  | { kind: "xr"; connection: XRConnection }
  | { kind: "smartglasses" }
  | null;

export class FacewearService extends Service {
  static override serviceType = FACEWEAR_SERVICE_TYPE;

  readonly capabilityDescription =
    "Unified facewear service — coordinates XR streaming and smartglasses BLE for Meta Quest, XReal, Even Realities G1/G2, and Apple Vision Pro.";

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    return new FacewearService(runtime);
  }

  override async stop(): Promise<void> {}

  getXRService(): XRSessionService | undefined {
    return (
      this.runtime.getService<XRSessionService>(XR_SERVICE_TYPE) ?? undefined
    );
  }

  getSmartglassesService(): SmartglassesService | undefined {
    return (this.runtime.getService<SmartglassesService>(
      SMARTGLASSES_SERVICE_NAME,
    ) ?? undefined) as SmartglassesService | undefined;
  }

  getConnectedDevices(): Array<{
    id: string;
    kind: "xr" | "smartglasses";
    deviceType?: string;
  }> {
    const devices: Array<{
      id: string;
      kind: "xr" | "smartglasses";
      deviceType?: string;
    }> = [];
    const xrSvc = this.getXRService();
    if (xrSvc) {
      for (const conn of xrSvc.getConnections()) {
        devices.push({ id: conn.id, kind: "xr", deviceType: conn.deviceType });
      }
    }
    const sgSvc = this.getSmartglassesService();
    if (sgSvc?.getStatus().connected) {
      devices.push({ id: "smartglasses", kind: "smartglasses" });
    }
    return devices;
  }

  hasActiveDevice(): boolean {
    return this.getConnectedDevices().length > 0;
  }
}
