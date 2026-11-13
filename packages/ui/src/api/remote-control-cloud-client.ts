/** Browser transport composition over the shared validated remote relay client. */
import {
  RemoteControlCloudClient as HostClient,
  type RemoteControlCloudClientOptions,
} from "@elizaos/plugin-browser/remote-control/cloud-client";
import { fetchAgentTransport } from "./transport";

export * from "@elizaos/plugin-browser/remote-control/cloud-client";
export class RemoteControlCloudClient extends HostClient {
  constructor(options: RemoteControlCloudClientOptions) {
    super({
      ...options,
      request:
        options.request ??
        ((url, init) =>
          fetchAgentTransport.request(url, init, { timeoutMs: 30000 })),
    });
  }
}
