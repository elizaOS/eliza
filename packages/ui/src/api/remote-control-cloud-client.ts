/** Browser transport composition over the shared validated remote relay client. */
import {
  RemoteControlCloudClient as HostClient,
  type RemoteControlCloudClientOptions,
} from "@elizaos/remote-control-host/cloud-client";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import { fetchAgentTransport } from "./transport";

export * from "@elizaos/remote-control-host/cloud-client";
export class RemoteControlCloudClient extends HostClient {
  constructor(options: RemoteControlCloudClientOptions) {
    super({
      ...options,
      request:
        options.request ??
        (async (url, init) => {
          const transport =
            desktopHttpTransportForUrl(url) ?? fetchAgentTransport;
          return transport.request(url, init, { timeoutMs: 30000 });
        }),
    });
  }
}
