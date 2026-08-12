/** Verifies detail-page deactivation copy follows the server-owned hosting DTO. */
// @vitest-environment jsdom

import type { AgentHostingCostDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaAgentActions } from "./agent-actions";

const { poller } = vi.hoisted(() => ({
  poller: {
    getStatus: vi.fn(() => undefined),
    isActive: vi.fn(() => false),
    track: vi.fn(),
  },
}));

vi.mock("../lib/i18n", () => ({
  useT:
    () =>
    (_key: string, options?: { defaultValue?: string; rate?: string }) => {
      const copy = options?.defaultValue ?? _key;
      return options?.rate ? copy.replace("{{rate}}", options.rate) : copy;
    },
}));
vi.mock("../lib/use-job-poller", () => ({ useJobPoller: () => poller }));
vi.mock("../lib/open-web-ui", () => ({ openWebUIWithPairing: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderActions(hostingCost: AgentHostingCostDto) {
  render(
    <MemoryRouter>
      <ElizaAgentActions
        agentId="00000000-1111-4222-8333-444444444444"
        executionTier="dedicated-always"
        status="running"
        hostingCost={hostingCost}
        webUiUrl={null}
      />
    </MemoryRouter>,
  );
}

describe("detail agent deactivation pricing", () => {
  it("shows the exact known DTO rate", async () => {
    const user = userEvent.setup();
    renderActions({
      pricingState: "known",
      rateClass: "running",
      hourlyRateUsd: 0.02,
      monthlyEstimateUsd: 14.4,
    });

    await user.click(screen.getByRole("button", { name: "Deactivate Agent" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("$0.02/hr");
    expect(dialog.textContent).not.toContain("$0.01/hr");
  });

  it("keeps the action available but omits rate and savings claims when unavailable", async () => {
    const user = userEvent.setup();
    renderActions({
      pricingState: "unavailable",
      rateClass: "unavailable",
      hourlyRateUsd: null,
      monthlyEstimateUsd: null,
    });

    await user.click(screen.getByRole("button", { name: "Deactivate Agent" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/current hosting price is unavailable/i),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Yes, deactivate" }),
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain("$");
  });
});
