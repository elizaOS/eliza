import { describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.js";
import type { OnboardingConnection } from "../contracts/onboarding.js";
import type { ServiceRoutingConfig } from "../contracts/service-routing.js";
import { applyOnboardingConnectionConfig } from "./provider-switch-config.js";

type MutableConfig = Partial<ElizaConfig> & {
  serviceRouting?: ServiceRoutingConfig;
};

function buildBaseConfig(): MutableConfig {
  return {};
}

const cloudConnection: OnboardingConnection = {
  kind: "cloud-managed",
  cloudProvider: "elizacloud",
  apiKey: "test-cloud-key",
};

describe("applyOnboardingConnectionConfig — useLocalEmbeddings", () => {
  it("routes embeddings to cloud-proxy by default for cloud-managed connection", async () => {
    const config = buildBaseConfig();

    await applyOnboardingConnectionConfig(config, cloudConnection);

    expect(config.serviceRouting?.embeddings).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
    });
    expect(config.serviceRouting?.tts).toMatchObject({
      transport: "cloud-proxy",
    });
  });

  it("translates useLocalEmbeddings: true to excludeServices: ['embeddings']", async () => {
    const config = buildBaseConfig();

    await applyOnboardingConnectionConfig(config, cloudConnection, {
      useLocalEmbeddings: true,
    });

    expect(config.serviceRouting?.embeddings).toBeUndefined();
    expect(config.serviceRouting?.tts).toMatchObject({
      transport: "cloud-proxy",
    });
    expect(config.serviceRouting?.media).toMatchObject({
      transport: "cloud-proxy",
    });
    expect(config.serviceRouting?.rpc).toMatchObject({
      transport: "cloud-proxy",
    });
  });

  it("keeps the cloud embeddings route when useLocalEmbeddings is false", async () => {
    const config = buildBaseConfig();

    await applyOnboardingConnectionConfig(config, cloudConnection, {
      useLocalEmbeddings: false,
    });

    expect(config.serviceRouting?.embeddings).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
    });
  });

  it("excludes embeddings on local-provider when previous deployment was cloud", async () => {
    const config: MutableConfig = {
      deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
    };

    await applyOnboardingConnectionConfig(
      config,
      {
        kind: "local-provider",
        provider: "openai",
        apiKey: "sk-test",
      },
      { useLocalEmbeddings: true },
    );

    expect(config.serviceRouting?.embeddings).toBeUndefined();
    expect(config.serviceRouting?.tts).toMatchObject({
      transport: "cloud-proxy",
    });
    expect(config.serviceRouting?.llmText).toMatchObject({
      backend: "openai",
      transport: "direct",
    });
  });
});
