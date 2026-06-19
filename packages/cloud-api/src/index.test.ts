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

  test("redirects app.* frontend host to apex (the /login 404 sign-in fix) without dropping path or query", () => {
    const response = redirectFrontendHost(
      new URL("https://app.elizacloud.ai/login?next=%2Fdashboard"),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe(
      "https://elizacloud.ai/login?next=%2Fdashboard",
    );
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
});
