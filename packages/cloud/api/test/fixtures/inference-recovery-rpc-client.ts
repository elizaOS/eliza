/** Transport fixture only: its test lease is not canonical accounting state. */
import { DurableObject } from "cloudflare:workers";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import { recoverExpiredInferenceAdmissionLease } from "../../../admission-worker/src/recovery-service";
export class TestClient extends DurableObject {
  async fetch(request: Request) {
    const fail = new URL(request.url).pathname === "/fail";
    await this.ctx.storage.put("lease", true);
    const calls: string[] = [];
    try {
      const result = await runWithCloudBindingsAsync(
        this.env as Record<string, unknown>,
        () =>
          recoverExpiredInferenceAdmissionLease(
            {
              version: 1,
              kind: "organization",
              organizationId: "owned",
              requestId: "same-operation",
              userId: "owned",
              model: "test",
              provider: "test",
              billingSource: "test",
              description: fail ? "fail" : "ok",
              accounting: { kind: "direct_debit" },
            },
            1,
            {
              inferenceBalanceFence: {
                lowerCommittedBalance: async () => {
                  calls.push("lower");
                },
                publishAuthoritativeBalance: async () => {
                  calls.push("publish");
                  await this.ctx.storage.put("published", true);
                  if (fail) throw Error("owned callback failed");
                },
              },
            },
          ),
      );
      await this.ctx.storage.delete("lease");
      return Response.json({
        result,
        calls,
        lease: (await this.ctx.storage.get("lease")) ?? false,
        published: await this.ctx.storage.get("published"),
      });
    } catch {
      return Response.json({
        calls,
        lease: await this.ctx.storage.get("lease"),
        published: await this.ctx.storage.get("published"),
      });
    }
  }
}
export default {
  fetch() {
    return new Response("private", { status: 404 });
  },
};
