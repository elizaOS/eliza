import { describe, expect, test } from "bun:test";
import { getFrontendAliasProxyTarget, redirectFrontendHost } from "./index";

describe("cloud-api worker entrypoint", () => {
  test("redirects www frontend host to apex without dropping path or query", () => {
    const response = redirectFrontendHost(
      new URL(
        "https://www.elizacloud.ai/dashboard/agents/e06bb509-6c52-4c33-a9f7-66addc43e8c8?tab=chat",
      ),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe(
      "https://elizacloud.ai/dashboard/agents/e06bb509-6c52-4c33-a9f7-66addc43e8c8?tab=chat",
    );
  });

  test("does NOT redirect app.* — it serves the Eliza agent app (D5 topology split)", () => {
    // Under D5, app.elizacloud.ai is the `eliza-app` Pages project, not the
    // apex console. The Worker must not 308 it to the apex.
    expect(
      redirectFrontendHost(
        new URL("https://app.elizacloud.ai/login?next=%2Fdashboard"),
        { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
      ),
    ).toBeNull();
  });

  test("does not redirect the apex or the api host", () => {
    expect(
      redirectFrontendHost(new URL("https://elizacloud.ai/login"), {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
      }),
    ).toBeNull();
    expect(
      redirectFrontendHost(new URL("https://api.elizacloud.ai/api/health"), {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
      }),
    ).toBeNull();
  });

  test("does not redirect generated agent subdomains", () => {
    const response = redirectFrontendHost(
      new URL("https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/"),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response).toBeNull();
  });

  test("proxies staging frontend aliases to the Pages develop branch", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://staging.elizacloud.ai/dashboard?tab=agents"),
    );

    expect(target?.toString()).toBe(
      "https://develop.eliza-cloud-enq.pages.dev/dashboard?tab=agents",
    );
  });

  test("proxies staging API aliases to the staging API worker", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://staging.elizacloud.ai/api/health"),
    );

    expect(target?.toString()).toBe(
      "https://api-staging.elizacloud.ai/api/health",
    );
  });

  test("feed.elizacloud.ai is inert when FEED_ORIGIN_HOST is unset", () => {
    // No env / empty host => falls through to the cloud-api app (no regression).
    expect(
      getFrontendAliasProxyTarget(new URL("https://feed.elizacloud.ai/feed")),
    ).toBeNull();
    expect(
      getFrontendAliasProxyTarget(new URL("https://feed.elizacloud.ai/feed"), {
        FEED_ORIGIN_HOST: "",
      }),
    ).toBeNull();
  });

  test("proxies feed.elizacloud.ai pages to the Railway origin when configured", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://feed.elizacloud.ai/markets?marketKind=prediction"),
      { FEED_ORIGIN_HOST: "feed-web-production.up.railway.app" },
    );

    expect(target?.toString()).toBe(
      "https://feed-web-production.up.railway.app/markets?marketKind=prediction",
    );
  });

  test("proxies feed /api/* to the SAME Railway origin (single origin, no app/api split)", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://feed.elizacloud.ai/api/health"),
      { FEED_ORIGIN_HOST: "feed-web-production.up.railway.app" },
    );

    expect(target?.toString()).toBe(
      "https://feed-web-production.up.railway.app/api/health",
    );
  });
});
