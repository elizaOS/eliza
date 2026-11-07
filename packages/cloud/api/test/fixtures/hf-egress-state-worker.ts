import {
  createHfProxyEgressQuotaStore,
  importCloudflareHfEgress,
} from "@elizaos/cloud-shared/lib/services/hf-proxy-egress-quota";
import type { Bindings } from "@elizaos/cloud-shared/types/cloud-worker-env";

export { HfEgressState } from "../../src/hf-egress-state";
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const input = (await request.json()) as {
      operation: string;
      organization: string;
      month: string;
      bytes: number;
      limit: number;
      expiresAt: number;
    };
    try {
      if (input.operation === "import") {
        if (!env.HF_EGRESS_STATE) throw new Error("Missing fixture binding");
        await importCloudflareHfEgress(
          env.HF_EGRESS_STATE,
          input.organization,
          input.month,
          input.bytes,
          input.expiresAt,
          true,
        );
        return Response.json({ imported: true });
      }
      const store = createHfProxyEgressQuotaStore(env);
      if (!store) throw new Error("Missing store");
      if (input.operation === "release") {
        await store.release(input.organization, input.month, input.bytes);
        return Response.json({ released: true });
      }
      return Response.json(
        await store.reserve(
          input.organization,
          input.month,
          input.bytes,
          input.limit,
        ),
      );
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : "unknown",
        },
        { status: 503 },
      );
    }
  },
};
