import { describe, expect, test } from "bun:test";
import { redirectFrontendHost } from "./index";

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

  test("does not redirect generated agent subdomains", () => {
    const response = redirectFrontendHost(
      new URL("https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/"),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response).toBeNull();
  });
});
