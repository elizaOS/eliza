import { ElizaClient } from "./client-base";

export interface XRDeviceConnection {
  id: string;
  deviceType: string;
  connectedAt: string;
}

export interface XRPairState {
  appUrl: string;
  pairingCode: string;
  connected: boolean;
  connections: XRDeviceConnection[];
  connectPageUrl: string;
}

declare module "./client-base" {
  interface ElizaClient {
    getXRPairState(): Promise<XRPairState>;
  }
}

ElizaClient.prototype.getXRPairState = async function (this: ElizaClient) {
  return this.fetch<XRPairState>("/api/xr/pair");
};
