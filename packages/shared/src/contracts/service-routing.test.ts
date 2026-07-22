/** Exercises service-routing builders and every persisted normalization boundary. */
import { describe, expect, it } from "vitest";
import {
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
  isLinkedAccountProviderId,
  normalizeDeploymentTargetConfig,
  normalizeLinkedAccountFlagConfig,
  normalizeLinkedAccountFlagsConfig,
  normalizeLinkedAccountRecord,
  normalizeLinkedAccountsRecords,
  normalizeServiceRouteConfig,
  normalizeServiceRoutingConfig,
} from "./service-routing";

describe("shared service-routing contracts", () => {
  it("builds complete cloud routes without replacing explicit services", () => {
    expect(
      buildElizaCloudServiceRoute({
        nanoModel: "nano",
        smallModel: "small",
        mediumModel: "medium",
        largeModel: "large",
        megaModel: "mega",
        responseHandlerModel: "response-handler",
        shouldRespondModel: "should-respond",
        actionPlannerModel: "action-planner",
        plannerModel: "planner",
        responseModel: "response",
        mediaDescriptionModel: "media-description",
      }),
    ).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
      accountId: "elizacloud",
      nanoModel: "nano",
      megaModel: "mega",
      mediaDescriptionModel: "media-description",
    });

    expect(
      buildDefaultElizaCloudServiceRouting({
        base: { tts: { backend: "custom" } },
        includeInference: true,
        excludeServices: ["media"],
        largeModel: "large",
      }),
    ).toMatchObject({
      llmText: { backend: "elizacloud", largeModel: "large" },
      tts: { backend: "custom" },
      embeddings: { backend: "elizacloud" },
      rpc: { backend: "elizacloud" },
    });
  });

  it("sanitizes legacy account flags and provider identifiers", () => {
    expect(
      normalizeLinkedAccountFlagConfig({
        status: "linked",
        source: "oauth",
        userId: " user ",
        organizationId: " org ",
      }),
    ).toEqual({
      status: "linked",
      source: "oauth",
      userId: "user",
      organizationId: "org",
    });
    expect(normalizeLinkedAccountFlagConfig({ status: "invalid" })).toBeNull();
    expect(
      normalizeLinkedAccountFlagsConfig({
        " account ": { status: "unlinked" },
        ignored: {},
      }),
    ).toEqual({ account: { status: "unlinked" } });
    expect(isLinkedAccountProviderId("cerebras-api")).toBe(true);
    expect(isLinkedAccountProviderId("unknown-provider")).toBe(false);
  });

  it("normalizes rich account records and rejects broken identity data", () => {
    const raw = {
      id: "account-1",
      providerId: "openai-api",
      label: " Primary ",
      source: "api-key",
      enabled: true,
      priority: 2,
      prioritySource: "explicit",
      createdAt: 10,
      lastUsedAt: 20,
      health: "rate-limited",
      healthDetail: { until: 30, lastError: " retry ", lastChecked: 25 },
      usage: {
        refreshedAt: 40,
        sessionPct: 25,
        weeklyPct: 50,
        resetsAt: 60,
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        requestCount: 4,
        weeklyModelBuckets: {
          Fable: { pct: 12, resetsAt: 70 },
        },
      },
      organizationId: " org ",
      userId: " user ",
      email: " test@example.com ",
    };
    expect(normalizeLinkedAccountRecord(raw)).toMatchObject({
      id: "account-1",
      label: "Primary",
      health: "rate-limited",
      prioritySource: "explicit",
      healthDetail: { until: 30, lastError: "retry" },
      usage: {
        refreshedAt: 40,
        sessionPct: 25,
        weeklyPct: 50,
        resetsAt: 60,
        weeklyModelBuckets: { Fable: { pct: 12, resetsAt: 70 } },
      },
      email: "test@example.com",
    });
    expect(
      normalizeLinkedAccountRecord({ ...raw, providerId: "unknown" }),
    ).toBeNull();
    expect(
      normalizeLinkedAccountsRecords({
        "account-1": raw,
        mismatch: raw,
        invalid: null,
      }),
    ).toEqual({ "account-1": expect.objectContaining({ id: "account-1" }) });
  });

  it("preserves every service route field and strips invalid values", () => {
    const route = normalizeServiceRouteConfig({
      backend: " openai ",
      transport: "direct",
      accountId: " primary ",
      accountIds: ["primary", " fallback ", "primary", 4],
      strategy: "reset-soonest",
      primaryModel: "primary-model",
      nanoModel: "nano",
      smallModel: "small",
      mediumModel: "medium",
      largeModel: "large",
      megaModel: "mega",
      responseHandlerModel: "response-handler",
      shouldRespondModel: "should-respond",
      actionPlannerModel: "action-planner",
      plannerModel: "planner",
      responseModel: "response",
      mediaDescriptionModel: "media-description",
      endpoint: " https://api.example/v1 ",
      apiKeyEnv: " API_KEY ",
      metadata: { region: "us-west" },
    });
    expect(route).toMatchObject({
      backend: "openai",
      accountIds: ["primary", "fallback"],
      strategy: "reset-soonest",
      megaModel: "mega",
    });
    expect(normalizeServiceRouteConfig({ strategy: "invalid" })).toBeNull();
    expect(
      normalizeServiceRoutingConfig({
        llmText: route,
        tts: { backend: "tts" },
        media: { backend: "media" },
        embeddings: { backend: "embeddings" },
        rpc: { backend: "rpc" },
        ignored: { backend: "ignored" },
      }),
    ).toMatchObject({
      llmText: { strategy: "reset-soonest" },
      tts: { backend: "tts" },
      rpc: { backend: "rpc" },
    });
  });

  it("normalizes deployment targets while rejecting missing runtime identity", () => {
    expect(
      normalizeDeploymentTargetConfig({
        runtime: "remote",
        provider: "remote",
        remoteApiBase: " https://agent.example ",
        remoteAccessToken: " token ",
      }),
    ).toEqual({
      runtime: "remote",
      provider: "remote",
      remoteApiBase: "https://agent.example",
      remoteAccessToken: "token",
    });
    expect(normalizeDeploymentTargetConfig({ runtime: "unknown" })).toBeNull();
    expect(normalizeDeploymentTargetConfig(null)).toBeNull();
  });
});
