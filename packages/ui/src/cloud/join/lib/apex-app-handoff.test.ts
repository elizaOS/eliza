import { describe, expect, it } from "vitest";
import { resolveApexJoinHandoff } from "./apex-app-handoff";

describe("apex /join app handoff", () => {
  it("routes production and staging apex hosts to their paired app chat host", () => {
    expect(resolveApexJoinHandoff("elizacloud.ai")).toBe(
      "https://cloud.eliza.app/",
    );
    expect(resolveApexJoinHandoff("www.elizacloud.ai")).toBe(
      "https://cloud.eliza.app/",
    );
    expect(resolveApexJoinHandoff("staging.elizacloud.ai")).toBe(
      "https://cloud-staging.eliza.app/",
    );
  });

  it("never redirects app, preview, per-agent, or lookalike hosts", () => {
    expect(resolveApexJoinHandoff("app.elizacloud.ai")).toBeNull();
    expect(resolveApexJoinHandoff("preview.pages.dev")).toBeNull();
    expect(resolveApexJoinHandoff("agent.elizacloud.ai")).toBeNull();
    expect(resolveApexJoinHandoff("elizacloud.ai.evil.example")).toBeNull();
  });
});
