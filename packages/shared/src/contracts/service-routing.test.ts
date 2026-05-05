import { describe, expect, it } from "vitest";

import {
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
} from "./service-routing.js";

describe("buildDefaultElizaCloudServiceRouting", () => {
  it("routes all default capabilities to cloud-proxy by default", () => {
    const routing = buildDefaultElizaCloudServiceRouting();

    expect(routing.embeddings?.transport).toBe("cloud-proxy");
    expect(routing.embeddings?.backend).toBe("elizacloud");
    expect(routing.tts?.transport).toBe("cloud-proxy");
    expect(routing.media?.transport).toBe("cloud-proxy");
    expect(routing.rpc?.transport).toBe("cloud-proxy");
    expect(routing.llmText).toBeUndefined();
  });

  it("omits embeddings when listed in excludeServices", () => {
    const routing = buildDefaultElizaCloudServiceRouting({
      excludeServices: ["embeddings"],
    });

    expect(routing.embeddings).toBeUndefined();
    expect(routing.tts?.transport).toBe("cloud-proxy");
    expect(routing.media?.transport).toBe("cloud-proxy");
    expect(routing.rpc?.transport).toBe("cloud-proxy");
  });

  it("preserves a pre-existing route on a non-excluded capability", () => {
    const customEmbeddings = buildElizaCloudServiceRoute({
      smallModel: "custom-embedding-model",
    });
    const routing = buildDefaultElizaCloudServiceRouting({
      base: { embeddings: customEmbeddings },
      excludeServices: ["tts"],
    });

    expect(routing.embeddings).toBe(customEmbeddings);
    expect(routing.embeddings?.smallModel).toBe("custom-embedding-model");
    expect(routing.tts).toBeUndefined();
    expect(routing.media?.transport).toBe("cloud-proxy");
    expect(routing.rpc?.transport).toBe("cloud-proxy");
  });

  it("treats an empty excludeServices the same as the default", () => {
    const routing = buildDefaultElizaCloudServiceRouting({
      excludeServices: [],
    });

    expect(routing.embeddings?.transport).toBe("cloud-proxy");
    expect(routing.tts?.transport).toBe("cloud-proxy");
    expect(routing.media?.transport).toBe("cloud-proxy");
    expect(routing.rpc?.transport).toBe("cloud-proxy");
  });
});
