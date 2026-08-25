/** Verifies Shared Agents never contribute to the Dedicated hosting estimate. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaAgentPricingBanner } from "./eliza-agent-pricing-banner";

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: Record<string, unknown>) => {
    let text = String(options?.defaultValue ?? _key);
    for (const [name, value] of Object.entries(options ?? {})) {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
    return text;
  },
}));

afterEach(cleanup);

describe("ElizaAgentPricingBanner", () => {
  it("renders a Shared-only account as free", () => {
    render(
      <ElizaAgentPricingBanner
        sharedCount={1}
        runningCount={0}
        idleCount={0}
        creditBalance={0}
      />,
    );

    expect(screen.getByText("$0.00/mo")).toBeTruthy();
    expect(screen.getByText("Shared Agent is free")).toBeTruthy();
    expect(screen.queryByText("0 running · 0 idle")).toBeNull();
    expect(screen.queryByText("Low balance")).toBeNull();
    expect(screen.queryByText(/Min\./)).toBeNull();
    expect(screen.queryByText(/Suspends at/)).toBeNull();
  });
});
