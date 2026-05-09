import type { IAgentRuntime, TestCase, TestSuite } from "@elizaos/core";
import { CloudTailscaleService } from "../services/CloudTailscaleService";
import { LocalTailscaleService } from "../services/LocalTailscaleService";

const CANONICAL_TUNNEL_SERVICE_TYPE = "tunnel";

export class TailscaleTestSuite implements TestSuite {
  name = "tailscale";
  tests: TestCase[] = [
    {
      name: "LocalTailscaleService claims canonical tunnel service-type",
      fn: (_runtime: IAgentRuntime) => {
        if (LocalTailscaleService.serviceType !== CANONICAL_TUNNEL_SERVICE_TYPE) {
          throw new Error(
            `LocalTailscaleService.serviceType must be "${CANONICAL_TUNNEL_SERVICE_TYPE}"`,
          );
        }
      },
    },
    {
      name: "CloudTailscaleService claims canonical tunnel service-type",
      fn: (_runtime: IAgentRuntime) => {
        if (CloudTailscaleService.serviceType !== CANONICAL_TUNNEL_SERVICE_TYPE) {
          throw new Error(
            `CloudTailscaleService.serviceType must be "${CANONICAL_TUNNEL_SERVICE_TYPE}"`,
          );
        }
      },
    },
  ];
}
