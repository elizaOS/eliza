/**
 * Canonical service-routing resolution: once a route matrix exists, unrelated
 * persisted provider credentials cannot manufacture ownership for an omitted
 * capability.
 */
import { describe, expect, it } from "vitest";
import { resolveServiceRoutingInConfig } from "./first-run-options";

describe("resolveServiceRoutingInConfig canonical ownership", () => {
  it("does not infer llmText from ambient credentials beside a media-only route", () => {
    const routing = resolveServiceRoutingInConfig({
      serviceRouting: {
        media: { backend: "elizacloud", transport: "cloud-proxy" },
      },
      env: { OPENAI_API_KEY: "sk-unrelated" },
    });

    expect(routing).toEqual({
      media: { backend: "elizacloud", transport: "cloud-proxy" },
    });
    expect(routing?.llmText).toBeUndefined();
  });
});
