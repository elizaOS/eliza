// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsXPanel } from "./LifeOpsOperationalPanels.js";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

const {
  agentRefresh,
  dispatchFocusConnector,
  ownerRefresh,
  setActionNotice,
  setTab,
} = vi.hoisted(() => ({
  agentRefresh: vi.fn(),
  dispatchFocusConnector: vi.fn(),
  ownerRefresh: vi.fn(),
  setActionNotice: vi.fn(),
  setTab: vi.fn(),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
}));

vi.mock("@elizaos/ui", async () => {
  const React = await import(
    "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
  );
  return {
    Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span {...props}>{children}</span>
    ),
    Button: React.forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        size?: string;
        variant?: string;
      }
    >(function Button({ size: _size, variant: _variant, ...props }, ref) {
      return <button ref={ref} {...props} />;
    }),
    dispatchFocusConnector,
    useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
    useApp: () => ({
      setActionNotice,
      setTab,
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? "",
    }),
  };
});

vi.mock("../hooks/useLifeOpsXConnector.js", () => ({
  useLifeOpsXConnector: (side: "owner" | "agent") => ({
    actionPending: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    error: null,
    loading: false,
    refresh: side === "owner" ? ownerRefresh : agentRefresh,
    status:
      side === "owner"
        ? {
            connected: true,
            identity: { username: "owner_handle" },
          }
        : {
            connected: false,
            identity: null,
          },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsXPanel", () => {
  it("keeps X connector control in connector settings and only refreshes status", () => {
    render(<LifeOpsXPanel />);

    expect(screen.getByText("owner_handle")).toBeTruthy();
    expect(screen.queryByText("Disconnect Owner")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Owner X" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Agent X" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(ownerRefresh).toHaveBeenCalledTimes(1);
    expect(agentRefresh).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Open X connector settings" }),
    );
    expect(setTab).toHaveBeenCalledWith("connectors");
    expect(dispatchFocusConnector).toHaveBeenCalledWith("x");
    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("plugin-x"),
      "info",
      4200,
    );
  });
});
