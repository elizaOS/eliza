/**
 * Unit tests for connector UI groups: validates grouping classification and status label derivation.
 */
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_UI_GROUPS,
  connectorStatusLabel,
  getConnectorUiGroupId,
} from "./connector-ui-groups.ts";

describe("connector-ui-groups", () => {
  it("exports standard CONNECTOR_UI_GROUPS catalog", () => {
    expect(CONNECTOR_UI_GROUPS.length).toBe(3);
    expect(CONNECTOR_UI_GROUPS.map((g) => g.id)).toEqual([
      "messaging",
      "social",
      "other",
    ]);
  });

  it("maps connector IDs to correct group", () => {
    expect(getConnectorUiGroupId("discord")).toBe("messaging");
    expect(getConnectorUiGroupId("telegram")).toBe("messaging");
    expect(getConnectorUiGroupId("twitter")).toBe("social");
    expect(getConnectorUiGroupId("farcaster")).toBe("social");
    expect(getConnectorUiGroupId("unknown-connector")).toBe("other");
  });

  it("derives connector status label and tone", () => {
    const t = (k: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? k;

    const failed = connectorStatusLabel(
      {
        enabled: true,
        configured: true,
        validationErrors: [],
        loadError: "Network failure",
      },
      t,
    );
    expect(failed.tone).toBe("danger");
    expect(failed.label).toBe("Load failed");

    const disabled = connectorStatusLabel(
      {
        enabled: false,
        configured: true,
        validationErrors: [],
      },
      t,
    );
    expect(disabled.tone).toBe("muted");
    expect(disabled.label).toBe("Disabled");

    const needsSetup = connectorStatusLabel(
      {
        enabled: true,
        configured: false,
        validationErrors: [],
      },
      t,
    );
    expect(needsSetup.tone).toBe("warn");
    expect(needsSetup.label).toBe("Needs setup");
  });
});
