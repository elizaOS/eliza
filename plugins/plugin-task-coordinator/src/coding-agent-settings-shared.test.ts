/**
 * Verifies settings migration helpers without rendering the React settings UI.
 */
import { describe, expect, it } from "vitest";
import {
  ADAPTER_NAME_TO_TAB,
  loadCodingAgentPrefs,
} from "./coding-agent-settings-shared";

describe("coding agent settings migration", () => {
  it("loads legacy provider values under canonical keys", () => {
    expect(
      loadCodingAgentPrefs(
        {
          ELIZA_OPENCODE_API_KEY: "legacy-key",
          ELIZA_OPENCODE_BASE_URL: "https://legacy.example",
        },
        {},
      ),
    ).toMatchObject({
      ELIZA_CODE_API_KEY: "legacy-key",
      ELIZA_CODE_BASE_URL: "https://legacy.example",
    });
  });

  it("gives canonical values precedence over contradictory legacy values", () => {
    expect(
      loadCodingAgentPrefs(
        {
          ELIZA_CODE_API_KEY: "canonical-key",
          ELIZA_OPENCODE_API_KEY: "legacy-key",
        },
        {},
      ).ELIZA_CODE_API_KEY,
    ).toBe("canonical-key");
  });

  it("maps legacy preflight adapter names to elizaOS", () => {
    expect(ADAPTER_NAME_TO_TAB.opencode).toBe("elizaos");
    expect(ADAPTER_NAME_TO_TAB["open code"]).toBe("elizaos");
  });
});
