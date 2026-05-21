import { describe, expect, it } from "vitest";
import { AuditDispatcher, InMemorySink } from "@elizaos/security";
import type {
  MediaProviderResult,
  VisionAnalysisOptions,
  VisionAnalysisProvider,
  VisionAnalysisResult,
} from "../providers/media-provider.ts";
import { GatedVisionProvider } from "./vision-gate.ts";

class StubVisionProvider implements VisionAnalysisProvider {
  name = "stub";
  calls = 0;
  async analyze(
    _o: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    this.calls++;
    return {
      success: true,
      data: { description: "ok" } as VisionAnalysisResult,
    };
  }
}

describe("GatedVisionProvider", () => {
  it("denies analyze when not enabled and emits vision.denied", async () => {
    const inner = new StubVisionProvider();
    const sink = new InMemorySink();
    const ad = new AuditDispatcher({ sinks: [sink] });
    const gated = new GatedVisionProvider(inner, { auditDispatcher: ad });
    await expect(gated.analyze({} as VisionAnalysisOptions)).rejects.toThrow(
      /Vision capability is disabled/,
    );
    expect(inner.calls).toBe(0);
    expect(sink.snapshot()[0]?.action).toBe("vision.denied");
  });

  it("delegates and emits vision.allowed when enabled", async () => {
    const inner = new StubVisionProvider();
    const sink = new InMemorySink();
    const ad = new AuditDispatcher({ sinks: [sink] });
    const gated = new GatedVisionProvider(inner, {
      enabled: true,
      auditDispatcher: ad,
    });
    await gated.analyze({} as VisionAnalysisOptions);
    expect(inner.calls).toBe(1);
    expect(sink.snapshot()[0]?.action).toBe("vision.allowed");
  });
});
