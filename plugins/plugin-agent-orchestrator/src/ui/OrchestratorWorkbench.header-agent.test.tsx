// @vitest-environment jsdom

/**
 * Capability-level coverage for the Orchestrator header in its empty state.
 * The real agent registry drives the accounts toggle rendered by the header.
 */

import { AgentSurfaceProvider, getViewRegistry } from "@elizaos/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchHeader } from "./OrchestratorWorkbench";

afterEach(cleanup);

describe("WorkbenchHeader agent surface", () => {
  it("exposes and activates accounts even when no orchestrator status exists", () => {
    const onToggleAccounts = vi.fn();
    render(
      <AgentSurfaceProvider viewId="orchestrator" viewType="gui">
        <WorkbenchHeader
          status={null}
          busy={false}
          isMobile={false}
          onPauseAll={vi.fn()}
          onResumeAll={vi.fn()}
          accountsOpen={false}
          onToggleAccounts={onToggleAccounts}
          t={(_key, options) => options?.defaultValue ?? ""}
        />
      </AgentSurfaceProvider>,
    );

    const registry = getViewRegistry("orchestrator", "gui");
    if (!registry) throw new Error("orchestrator registry missing");
    const elements = registry.snapshot().elements;
    expect(elements).toContainEqual(
      expect.objectContaining({
        id: "header-accounts-toggle",
        role: "toggle",
        status: "inactive",
      }),
    );

    expect(registry.click("header-accounts-toggle").ok).toBe(true);
    expect(onToggleAccounts).toHaveBeenCalledOnce();
  });
});
