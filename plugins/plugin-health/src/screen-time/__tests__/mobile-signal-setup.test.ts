import { describe, expect, it } from "vitest";
import {
  type MobileSignalSetupActionLike,
  mobileSignalSetupActionBadge,
} from "./mobile-signal-setup.ts";

const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

describe("mobileSignalSetupActionBadge", () => {
  it("renders ready as secondary", () => {
    const action: MobileSignalSetupActionLike = {
      id: "a",
      label: "Usage Stats",
      status: "ready",
      canRequest: false,
    };
    const badge = mobileSignalSetupActionBadge(action, t);
    expect(badge.variant).toBe("secondary");
    expect(badge.label).toBe("Ready");
  });

  it("renders unavailable as outline", () => {
    const action: MobileSignalSetupActionLike = {
      id: "a",
      label: "Screen Time",
      status: "unavailable",
      canRequest: false,
    };
    const badge = mobileSignalSetupActionBadge(action, t);
    expect(badge.variant).toBe("outline");
    expect(badge.label).toBe("Unavailable");
  });
});
