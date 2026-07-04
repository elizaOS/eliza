// @vitest-environment jsdom
//
// AgentProvisioningWidget lifecycle: renders the migrating state (opening chat on
// tap), a Retry control on a failed handoff (dispatching the retry event), and
// self-hides once the dedicated agent attaches or for a local/non-shared runtime.
// jsdom render with the cloud-compat agent helpers + events mocked (no backend).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudHandoffPhaseDetail } from "../../../events";
import { CLOUD_HANDOFF_RETRY_EVENT } from "../../../events";

const {
  getCloudCompatAgentMock,
  isDirectCloudSharedAgentBaseMock,
  loadPersistedActiveServerMock,
  useCloudHandoffPhaseMock,
  navOpenTab,
} = vi.hoisted(() => ({
  getCloudCompatAgentMock: vi.fn(),
  isDirectCloudSharedAgentBaseMock: vi.fn(() => true),
  loadPersistedActiveServerMock: vi.fn(),
  useCloudHandoffPhaseMock: vi.fn<() => CloudHandoffPhaseDetail | null>(
    () => null,
  ),
  navOpenTab: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: { getCloudCompatAgent: getCloudCompatAgentMock },
}));
vi.mock("../../../api/client-cloud", () => ({
  isDirectCloudSharedAgentBase: isDirectCloudSharedAgentBaseMock,
}));
vi.mock("../../../state/persistence", () => ({
  loadPersistedActiveServer: loadPersistedActiveServerMock,
}));
vi.mock("../../../hooks/useCloudHandoffPhase", () => ({
  useCloudHandoffPhase: useCloudHandoffPhaseMock,
}));
// useWidgetNavigation → reportUserViewSwitch; stub it so the click test isolates
// the navigation call.
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));
vi.mock("./home-widget-card", async () => {
  const react = await import("react");
  return {
    useWidgetNavigation: () => ({ openView: vi.fn(), openTab: navOpenTab }),
    HomeWidgetCard: ({
      value,
      badge,
      testId,
      ariaLabel,
      onActivate,
    }: {
      value?: React.ReactNode;
      badge?: React.ReactNode;
      testId: string;
      ariaLabel: string;
      onActivate: () => void;
    }) =>
      react.createElement(
        "button",
        {
          type: "button",
          "data-testid": testId,
          "aria-label": ariaLabel,
          onClick: onActivate,
        },
        react.createElement("span", { "data-testid": "value" }, value),
        badge != null
          ? react.createElement("span", { "data-testid": "badge" }, badge)
          : null,
      ),
  };
});

import { AgentProvisioningWidget } from "./agent-provisioning";

const SHARED_SERVER = {
  id: "cloud:agent-123",
  kind: "cloud" as const,
  label: "Eliza Cloud",
  apiBase: "https://www.elizacloud.ai/api/v1/eliza/agents/agent-123",
};

function phase(p: CloudHandoffPhaseDetail["phase"]): CloudHandoffPhaseDetail {
  return { agentId: "agent-123", phase: p };
}

describe("AgentProvisioningWidget", () => {
  beforeEach(() => {
    getCloudCompatAgentMock.mockReset();
    getCloudCompatAgentMock.mockResolvedValue({ success: false });
    isDirectCloudSharedAgentBaseMock.mockReturnValue(true);
    loadPersistedActiveServerMock.mockReturnValue(SHARED_SERVER);
    useCloudHandoffPhaseMock.mockReturnValue(null);
    navOpenTab.mockReset();
  });
  afterEach(cleanup);

  it("renders the provisioning state while migrating and opens chat on tap", () => {
    useCloudHandoffPhaseMock.mockReturnValue(phase("migrating"));
    render(<AgentProvisioningWidget />);
    const tile = screen.getByTestId("chat-widget-agent-provisioning");
    expect(screen.getByTestId("value").textContent).toBe("Setting up…");
    fireEvent.click(tile);
    expect(navOpenTab).toHaveBeenCalledWith("chat");
  });

  it("renders on a shared cloud server even before any handoff phase arrives", () => {
    useCloudHandoffPhaseMock.mockReturnValue(null);
    render(<AgentProvisioningWidget />);
    expect(screen.getByTestId("chat-widget-agent-provisioning")).toBeTruthy();
    expect(screen.getByTestId("value").textContent).toBe("Setting up…");
  });

  it("renders a Retry control on a failed handoff and dispatches the retry event", () => {
    useCloudHandoffPhaseMock.mockReturnValue(phase("failed"));
    const onRetry = vi.fn();
    window.addEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry);
    render(<AgentProvisioningWidget />);
    expect(screen.getByTestId("value").textContent).toBe("Setup paused");
    expect(screen.getByTestId("badge").textContent).toBe("Retry");
    fireEvent.click(screen.getByTestId("chat-widget-agent-provisioning"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const detail = (onRetry.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ agentId: "agent-123" });
    window.removeEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry);
  });

  it("self-hides once the dedicated agent is attached (switched phase)", () => {
    useCloudHandoffPhaseMock.mockReturnValue(phase("switched"));
    const { container } = render(<AgentProvisioningWidget />);
    expect(screen.queryByTestId("chat-widget-agent-provisioning")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("self-hides for a non-cloud (local) runtime", () => {
    loadPersistedActiveServerMock.mockReturnValue({
      id: "local",
      kind: "local",
      label: "This device",
    });
    useCloudHandoffPhaseMock.mockReturnValue(null);
    const { container } = render(<AgentProvisioningWidget />);
    expect(container.firstChild).toBeNull();
  });

  it("self-hides when the active cloud server is already on a dedicated (non-shared) base", () => {
    isDirectCloudSharedAgentBaseMock.mockReturnValue(false);
    loadPersistedActiveServerMock.mockReturnValue({
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://agent-123.elizacloud.ai",
    });
    useCloudHandoffPhaseMock.mockReturnValue(null);
    const { container } = render(<AgentProvisioningWidget />);
    expect(container.firstChild).toBeNull();
  });
});
