import { describe, expect, it } from "vitest";
import { applyModelGatewayEnv } from "../services/model-gateway.js";
import { shouldForwardEnv } from "../services/sub-agent-env-policy.js";

describe("gateway credential isolation", () => {
  it("removes legacy credentials and their carriers from the final child environment", () => {
    const credential = "fixture-legacy-provider-credential";
    const environment: NodeJS.ProcessEnv = {
      ELIZA_E2E_CEREBRAS_API_KEY: credential,
      ELIZA_AGENT_CONFIG: JSON.stringify({ credential }),
      PATH: "/usr/bin",
    };

    expect(shouldForwardEnv("ELIZA_E2E_CEREBRAS_API_KEY")).toBe(true);
    applyModelGatewayEnv(environment, {
      url: "https://gateway.example.test/v1",
      token: "fixture-gateway-lease",
    });

    expect(environment.ELIZA_E2E_CEREBRAS_API_KEY).toBeUndefined();
    expect(environment.ELIZA_AGENT_CONFIG).toBeUndefined();
    expect(JSON.stringify(environment)).not.toContain(credential);
    expect(environment.OPENAI_API_KEY).toBe("fixture-gateway-lease");
    expect(environment.ANTHROPIC_API_KEY).toBe("fixture-gateway-lease");
    expect(environment.PATH).toBe("/usr/bin");
  });
});
