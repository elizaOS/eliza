// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCompatAgent } from "../../api/client-types-cloud";

const appMock = vi.hoisted(() => ({
  value: {} as {
    elizaCloudConnected: boolean;
    setActionNotice: ReturnType<typeof vi.fn>;
  },
}));

const clientMock = vi.hoisted(() => ({
  getCloudCompatAgents: vi.fn(),
  updateCloudCompatAgent: vi.fn(),
  deleteCloudCompatAgent: vi.fn(),
  suspendCloudCompatAgent: vi.fn(),
  resumeCloudCompatAgent: vi.fn(),
  selectOrProvisionCloudAgent: vi.fn(),
}));

const persistenceMock = vi.hoisted(() => ({
  loadPersistedActiveServer: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  // The rename path never calls this, but the component imports it — pass args
  // through so any incidental call returns a record shaped like the real fn.
  createPersistedActiveServer: vi.fn((args: Record<string, unknown>) => args),
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../api/client-cloud", () => ({
  resolveCloudAgentApiBase: () => "https://agent.example.test",
}));

vi.mock("../../config/boot-config", () => ({
  getBootConfig: () => ({ cloudApiBase: "https://www.elizacloud.ai" }),
}));

vi.mock("../../config/branding", () => ({
  useBranding: () => ({ appName: "Eliza" }),
}));

vi.mock("../../state/persistence", () => persistenceMock);

import { CloudAgentsSection } from "./CloudAgentsSection";

function agent(overrides: Partial<CloudCompatAgent> = {}): CloudCompatAgent {
  return {
    agent_id: "agent-1",
    agent_name: "Old Name",
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: null,
    web_ui_url: null,
    status: "running",
    agent_config: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    containerUrl: "",
    webUiUrl: null,
    database_status: "ready",
    error_message: null,
    last_heartbeat_at: null,
    ...overrides,
  };
}

async function renderWithAgents(list: CloudCompatAgent[]) {
  clientMock.getCloudCompatAgents.mockResolvedValue({
    success: true,
    data: list,
  });
  render(<CloudAgentsSection />);
  // Wait for the initial refresh() to resolve and render the rows.
  await waitFor(() =>
    expect(
      screen.getByTestId(`cloud-agent-rename-${list[0].agent_id}`),
    ).toBeTruthy(),
  );
}

describe("CloudAgentsSection rename", () => {
  beforeEach(() => {
    appMock.value = {
      elizaCloudConnected: true,
      setActionNotice: vi.fn(),
    };
    clientMock.getCloudCompatAgents.mockReset();
    clientMock.updateCloudCompatAgent.mockReset();
    persistenceMock.loadPersistedActiveServer.mockReset();
    persistenceMock.savePersistedActiveServer.mockReset();
    // No active cloud server by default → activeId === null.
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:agent-1",
      label: "Old Name",
      accessToken: "tok",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renames an agent: calls updateCloudCompatAgent and shows the new name", async () => {
    clientMock.updateCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { agentId: "agent-1", agentName: "New Name" },
    });
    await renderWithAgents([agent()]);

    fireEvent.click(screen.getByTestId("cloud-agent-rename-agent-1"));
    const input = screen.getByTestId(
      "cloud-agent-rename-input-agent-1",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.click(screen.getByTestId("cloud-agent-rename-save-agent-1"));

    await waitFor(() =>
      expect(clientMock.updateCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
        {
          agentName: "New Name",
        },
      ),
    );
    // Row reconciles to the new name (editing closes, label updates).
    await waitFor(() => expect(screen.getByText("New Name")).toBeTruthy());
  });

  it("is a no-op when the name is unchanged (no client call)", async () => {
    await renderWithAgents([agent({ agent_name: "Same" })]);

    fireEvent.click(screen.getByTestId("cloud-agent-rename-agent-1"));
    // Leave the value as the current name and save.
    fireEvent.click(screen.getByTestId("cloud-agent-rename-save-agent-1"));

    expect(clientMock.updateCloudCompatAgent).not.toHaveBeenCalled();
    // Editing closed back to the row view.
    await waitFor(() =>
      expect(screen.getByTestId("cloud-agent-rename-agent-1")).toBeTruthy(),
    );
  });

  it("is a no-op when the name is empty/whitespace (no client call)", async () => {
    await renderWithAgents([agent({ agent_name: "Keep" })]);

    fireEvent.click(screen.getByTestId("cloud-agent-rename-agent-1"));
    const input = screen.getByTestId("cloud-agent-rename-input-agent-1");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("cloud-agent-rename-save-agent-1"));

    expect(clientMock.updateCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("reverts and surfaces an error when the rename fails", async () => {
    clientMock.updateCloudCompatAgent.mockResolvedValue({
      success: false,
      error: "boom",
      data: { agentId: "agent-1", agentName: "" },
    });
    await renderWithAgents([agent({ agent_name: "Original" })]);

    fireEvent.click(screen.getByTestId("cloud-agent-rename-agent-1"));
    fireEvent.change(screen.getByTestId("cloud-agent-rename-input-agent-1"), {
      target: { value: "Attempt" },
    });
    fireEvent.click(screen.getByTestId("cloud-agent-rename-save-agent-1"));

    await waitFor(() =>
      expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
        "boom",
        "error",
        expect.any(Number),
      ),
    );
    // The active-server label must NOT be rewritten on a failed rename.
    expect(persistenceMock.savePersistedActiveServer).not.toHaveBeenCalled();
    // Cancel the (still-open) editor and confirm the row reverted to the
    // original name — no optimistic name leaked into the list.
    fireEvent.click(screen.getByTestId("cloud-agent-rename-cancel-agent-1"));
    await waitFor(() => expect(screen.getByText("Original")).toBeTruthy());
    expect(screen.queryByText("Attempt")).toBeNull();
  });

  it("updates the persisted active-server label when renaming the active agent", async () => {
    // agent-1 is the active cloud server.
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:agent-1",
      label: "Old Name",
      accessToken: "tok",
    });
    clientMock.updateCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { agentId: "agent-1", agentName: "Renamed Active" },
    });
    await renderWithAgents([agent({ agent_name: "Old Name" })]);

    fireEvent.click(screen.getByTestId("cloud-agent-rename-agent-1"));
    fireEvent.change(screen.getByTestId("cloud-agent-rename-input-agent-1"), {
      target: { value: "Renamed Active" },
    });
    fireEvent.click(screen.getByTestId("cloud-agent-rename-save-agent-1"));

    await waitFor(() =>
      expect(persistenceMock.savePersistedActiveServer).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "cloud",
          id: "cloud:agent-1",
          label: "Renamed Active",
        }),
      ),
    );
  });

  it("does NOT touch the persisted active server when renaming a non-active agent", async () => {
    // The active server is a DIFFERENT agent (agent-2), so renaming agent-1
    // must not rewrite the persisted label.
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:agent-2",
      label: "Other",
      accessToken: "tok",
    });
    clientMock.updateCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { agentId: "agent-1", agentName: "New" },
    });
    await renderWithAgents([agent({ agent_id: "agent-1", agent_name: "A1" })]);

    fireEvent.click(screen.getByTestId("cloud-agent-rename-agent-1"));
    fireEvent.change(screen.getByTestId("cloud-agent-rename-input-agent-1"), {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByTestId("cloud-agent-rename-save-agent-1"));

    await waitFor(() =>
      expect(clientMock.updateCloudCompatAgent).toHaveBeenCalled(),
    );
    expect(persistenceMock.savePersistedActiveServer).not.toHaveBeenCalled();
  });
});
