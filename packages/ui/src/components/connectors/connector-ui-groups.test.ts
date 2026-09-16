/** Exercises connector grouping and status presentation behavior. */
import { describe, expect, it } from "vitest";
import {
  connectorStatusLabel,
  getConnectorUiGroupId,
} from "./connector-ui-groups.ts";

describe("connector-ui-groups", () => {
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
