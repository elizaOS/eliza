import { afterEach, describe, expect, it } from "bun:test";
import { resolveApiWorkerTarget } from "../../../apps/frontend/functions/_proxy";
import { onRequest as apiProxy } from "../../../apps/frontend/functions/api/[[path]]";
import { onRequest as stewardProxy } from "../../../apps/frontend/functions/steward/[[path]]";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetches(): Request[] {
  const requests: Request[] = [];

  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);

    return new Response("ok", {
      headers: { "x-target": request.url },
    });
  }) as typeof fetch;

  return requests;
}

describe("Cloudflare Pages Functions proxy", () => {
  it("routes Pages preview /api traffic to the staging Worker by default", async () => {
    const requests = captureFetches();
    const response = await apiProxy({
      request: new Request("https://eliza-cloud-enq.pages.dev/api/credits/balance?fresh=1", {
        headers: { "x-test-header": "present" },
        method: "POST",
      }),
      env: {},
    });

    expect(response.headers.get("x-target")).toBe(
      "https://api-staging.elizacloud.ai/api/credits/balance?fresh=1",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("x-test-header")).toBe("present");
  });

  it("routes custom-domain /api traffic to the production Worker by default", () => {
    expect(resolveApiWorkerTarget("https://elizacloud.ai/api/v1/user", {})).toBe(
      "https://api.elizacloud.ai/api/v1/user",
    );
  });

  it("honors API_UPSTREAM overrides and trims trailing slashes", () => {
    expect(
      resolveApiWorkerTarget("https://staging.elizacloud.ai/api/v1/eliza/agents", {
        API_UPSTREAM: "https://api-staging.elizacloud.ai/",
      }),
    ).toBe("https://api-staging.elizacloud.ai/api/v1/eliza/agents");
  });

  it("routes same-origin /steward traffic through the same Worker upstream", async () => {
    const requests = captureFetches();
    const response = await stewardProxy({
      request: new Request("https://eliza-cloud-enq.pages.dev/steward/tenants/config"),
      env: {},
    });

    expect(response.headers.get("x-target")).toBe(
      "https://api-staging.elizacloud.ai/steward/tenants/config",
    );
    expect(requests).toHaveLength(1);
  });
});
