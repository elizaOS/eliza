// @vitest-environment jsdom

/**
 * Covers CloudAgentsSection rename (client call + persisted active-server label
 * sync, no-op on unchanged/empty names, error revert) and suspend/resume
 * lifecycle (direct-path client calls, error surfacing, status re-sync). jsdom
 * render with the app store, cloud API client, and persistence mocked.
 */

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
  getCloudCompatJobStatus: vi.fn(),
  getCloudCompatAgentStatus: vi.fn(),
  selectOrProvisionCloudAgent: vi.fn(),
}));

/** A status-poll response shaped like `getCloudCompatAgentStatus` returns. */
function statusResponse(status: string, suspendedReason: string | null = null) {
  return {
    success: true,
    data: {
      status,
      lastHeartbeat: null,
      bridgeUrl: null,
      webUiUrl: null,
      currentNode: null,
      suspendedReason,
      databaseStatus: "ready",
    },
  };
}

const persistenceMock = vi.hoisted(() => ({
  loadPersistedActiveServer: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  // The rename path never calls this, but the component imports it — pass args
  // through so any incidental call returns a record shaped like the real fn.
  createPersistedActiveServer: vi.fn((args: Record<string, unknown>) => args),
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: typeof appMock.value) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../api/client-cloud", () => ({
  resolveCloudAgentApiBase: () => "https://agent.example.test",
  // currentCloudToken now resolves Steward-first via getCloudAuthToken; return
  // null so it falls through to the persisted active-server token these tests set.
  getCloudAuthToken: () => null,
}));

vi.mock("../../config/boot-config", () => ({
  getBootConfig: () => ({ cloudApiBase: "https://elizacloud.ai" }),
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

/** Shared mock setup for the lifecycle / load-state suites below. */
function resetClientMocks() {
  clientMock.getCloudCompatAgents.mockReset();
  clientMock.deleteCloudCompatAgent.mockReset();
  clientMock.suspendCloudCompatAgent.mockReset();
  clientMock.resumeCloudCompatAgent.mockReset();
  clientMock.getCloudCompatJobStatus.mockReset();
  clientMock.getCloudCompatAgentStatus.mockReset();
  persistenceMock.loadPersistedActiveServer.mockReset();
  persistenceMock.savePersistedActiveServer.mockReset();
  // deleteAgent now guards on window.confirm; default it to accept so the
  // lifecycle tests exercise the delete path (the dismissal path is tested
  // explicitly below).
  window.confirm = () => true;
}

describe("CloudAgentsSection lifecycle (suspend/resume)", () => {
  beforeEach(() => {
    appMock.value = { elizaCloudConnected: true, setActionNotice: vi.fn() };
    resetClientMocks();
    // The active server is a DIFFERENT agent so the row's Power/Start buttons
    // are not gated by the active-agent guard.
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:other",
      label: "Other",
      accessToken: "tok",
    });
    // Default the post-action status re-sync poll to a settled state so the
    // fire-and-forget poll never rejects in tests that don't assert on it.
    clientMock.getCloudCompatAgentStatus.mockResolvedValue(
      statusResponse("running"),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("suspends a running agent via the (direct-path) client call", async () => {
    clientMock.suspendCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-s", status: "queued", message: "Suspend enqueued" },
    });
    await renderWithAgents([agent({ status: "running" })]);

    fireEvent.click(
      screen.getByLabelText("Shut down Old Name", { selector: "button" }),
    );

    await waitFor(() =>
      expect(clientMock.suspendCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );
    // Optimistic transition + success notice.
    await waitFor(() =>
      expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
        expect.stringContaining("Shutting down"),
        "success",
        expect.any(Number),
      ),
    );
  });

  it("surfaces an error when suspend fails (e.g. 404 with no direct path)", async () => {
    clientMock.suspendCloudCompatAgent.mockResolvedValue({
      success: false,
      error: "Not found",
      data: { jobId: "", status: "error", message: "Not found" },
    });
    await renderWithAgents([agent({ status: "running" })]);

    fireEvent.click(
      screen.getByLabelText("Shut down Old Name", { selector: "button" }),
    );

    await waitFor(() =>
      expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
        expect.any(String),
        "error",
        expect.any(Number),
      ),
    );
  });

  it("resumes a stopped agent via the (direct-path) client call", async () => {
    clientMock.resumeCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-r", status: "queued", message: "Resume enqueued" },
    });
    await renderWithAgents([agent({ status: "stopped" })]);

    fireEvent.click(
      screen.getByLabelText("Start Old Name", { selector: "button" }),
    );

    await waitFor(() =>
      expect(clientMock.resumeCloudCompatAgent).toHaveBeenCalledWith("agent-1"),
    );
    await waitFor(() =>
      expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
        expect.stringContaining("Starting"),
        "success",
        expect.any(Number),
      ),
    );
  });

  it("re-syncs the row status after a suspend via the status poll", async () => {
    clientMock.suspendCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-s", status: "queued", message: "Suspend enqueued" },
    });
    // The daemon's job has flipped the agent to "stopped" by the first poll.
    clientMock.getCloudCompatAgentStatus.mockResolvedValue(
      statusResponse("stopped"),
    );
    await renderWithAgents([agent({ status: "running" })]);

    // Optimistic transition badge first.
    fireEvent.click(
      screen.getByLabelText("Shut down Old Name", { selector: "button" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("cloud-agent-status-agent-1").textContent).toBe(
        "Stopping",
      ),
    );

    // The fire-and-forget poll reconciles the row to the real server state
    // without a manual Refresh.
    await waitFor(
      () =>
        expect(clientMock.getCloudCompatAgentStatus).toHaveBeenCalledWith(
          "agent-1",
        ),
      { timeout: 6000 },
    );
    await waitFor(
      () =>
        expect(
          screen.getByTestId("cloud-agent-status-agent-1").textContent,
        ).toBe("Stopped"),
      { timeout: 6000 },
    );
  });

  it("re-syncs the row status after a resume via the status poll", async () => {
    clientMock.resumeCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-r", status: "queued", message: "Resume enqueued" },
    });
    clientMock.getCloudCompatAgentStatus.mockResolvedValue(
      statusResponse("running"),
    );
    await renderWithAgents([agent({ status: "stopped" })]);

    fireEvent.click(
      screen.getByLabelText("Start Old Name", { selector: "button" }),
    );
    await waitFor(
      () =>
        expect(clientMock.getCloudCompatAgentStatus).toHaveBeenCalledWith(
          "agent-1",
        ),
      { timeout: 6000 },
    );
    await waitFor(
      () =>
        expect(
          screen.getByTestId("cloud-agent-status-agent-1").textContent,
          // `agentLifecycleLabel` renders the product copy for the lifecycle
          // enum: a `running` cloud agent shows "Ready", not the raw "Running".
        ).toBe("Ready"),
      { timeout: 6000 },
    );
  });
});

describe("CloudAgentsSection waking on switch", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    appMock.value = { elizaCloudConnected: true, setActionNotice: vi.fn() };
    resetClientMocks();
    // A DIFFERENT agent is active so the target row renders a "Use" button.
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:other",
      label: "Other",
      accessToken: "tok",
    });
    // bindAndReload reboots the app — stub reload so jsdom doesn't error.
    reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("wakes a suspended agent on switch: resumes, shows waking, then binds once running", async () => {
    clientMock.resumeCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-r", status: "queued", message: "Resume enqueued" },
    });
    // First readiness poll still provisioning, second poll running.
    clientMock.getCloudCompatAgentStatus
      .mockResolvedValueOnce(statusResponse("provisioning"))
      .mockResolvedValueOnce(statusResponse("running"));
    await renderWithAgents([agent({ status: "suspended" })]);

    fireEvent.click(screen.getByText("Use"));

    // The non-running switch must resume the agent.
    await waitFor(() =>
      expect(clientMock.resumeCloudCompatAgent).toHaveBeenCalledWith("agent-1"),
    );
    // A "Waking <name>…" state shows until readiness.
    await waitFor(() =>
      expect(screen.getByText(/Waking Old Name/)).toBeTruthy(),
    );

    // Once the readiness poll reports running, it binds + reboots.
    await waitFor(() => expect(reloadSpy).toHaveBeenCalled(), {
      timeout: 6000,
    });
    expect(clientMock.getCloudCompatAgentStatus).toHaveBeenCalledWith(
      "agent-1",
    );
  });

  it("does not wake (resume) a running agent on switch — binds directly", async () => {
    await renderWithAgents([agent({ status: "running" })]);

    fireEvent.click(screen.getByText("Use"));

    await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    expect(clientMock.resumeCloudCompatAgent).not.toHaveBeenCalled();
    expect(clientMock.getCloudCompatAgentStatus).not.toHaveBeenCalled();
  });

  it("surfaces an error and does not bind when the resume call is rejected", async () => {
    clientMock.resumeCloudCompatAgent.mockResolvedValue({
      success: false,
      data: { jobId: "", status: "error", message: "no capacity" },
    });
    await renderWithAgents([agent({ status: "stopped" })]);

    fireEvent.click(screen.getByText("Use"));

    await waitFor(() =>
      expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
        expect.any(String),
        "error",
        expect.any(Number),
      ),
    );
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(persistenceMock.savePersistedActiveServer).not.toHaveBeenCalled();
  });
});

describe("CloudAgentsSection error surface", () => {
  beforeEach(() => {
    appMock.value = { elizaCloudConnected: true, setActionNotice: vi.fn() };
    resetClientMocks();
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:other",
      label: "Other",
      accessToken: "tok",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders error_message with a danger badge on a failed agent row", async () => {
    await renderWithAgents([
      agent({
        status: "error",
        error_message: "container OOMKilled at boot",
      }),
    ]);

    const detail = screen.getByTestId("cloud-agent-error-agent-1");
    expect(detail.textContent).toBe("container OOMKilled at boot");
    // The status badge is danger-toned for an error state.
    expect(
      screen.getByTestId("cloud-agent-status-agent-1").dataset.status,
    ).toBe("danger");
  });

  it("does not render an error detail for a healthy running agent", async () => {
    await renderWithAgents([agent({ status: "running", error_message: null })]);

    expect(screen.queryByTestId("cloud-agent-error-agent-1")).toBeNull();
    expect(
      screen.getByTestId("cloud-agent-status-agent-1").dataset.status,
    ).toBe("success");
  });
});

describe("CloudAgentsSection delete (job polling)", () => {
  beforeEach(() => {
    appMock.value = { elizaCloudConnected: true, setActionNotice: vi.fn() };
    resetClientMocks();
    // The active server is a DIFFERENT agent so delete is not disabled.
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:other",
      label: "Other",
      accessToken: "tok",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("polls the delete job and removes the row only once completed", async () => {
    clientMock.deleteCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-del", status: "deleting", message: "queued" },
    });
    // First poll still processing, second poll completed.
    clientMock.getCloudCompatJobStatus
      .mockResolvedValueOnce({
        success: true,
        data: { jobId: "job-del", status: "processing" },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { jobId: "job-del", status: "completed" },
      });
    await renderWithAgents([agent({ agent_name: "ToDelete" })]);

    // Row is present before delete completes.
    expect(screen.getByText("ToDelete")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Delete ToDelete"));

    await waitFor(
      () =>
        expect(clientMock.getCloudCompatJobStatus).toHaveBeenCalledWith(
          "job-del",
        ),
      { timeout: 5000 },
    );
    // Row removed only after the job reports completed.
    await waitFor(() => expect(screen.queryByText("ToDelete")).toBeNull(), {
      timeout: 5000,
    });
    expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Deleted"),
      "success",
      expect.any(Number),
    );
  });

  it("keeps the row and surfaces an error when the delete job fails", async () => {
    clientMock.deleteCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-del", status: "deleting", message: "queued" },
    });
    clientMock.getCloudCompatJobStatus.mockResolvedValue({
      success: true,
      data: { jobId: "job-del", status: "failed", error: "teardown blew up" },
    });
    await renderWithAgents([agent({ agent_name: "Sticky" })]);

    fireEvent.click(screen.getByLabelText("Delete Sticky"));

    await waitFor(() =>
      expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
        "teardown blew up",
        "error",
        expect.any(Number),
      ),
    );
    // A failed job triggers a re-sync (refresh) rather than dropping the row.
    await waitFor(() =>
      expect(clientMock.getCloudCompatAgents.mock.calls.length).toBeGreaterThan(
        1,
      ),
    );
  });

  it("removes the row immediately for a synchronous delete (no jobId)", async () => {
    clientMock.deleteCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "", status: "deleted", message: "done" },
    });
    await renderWithAgents([agent({ agent_name: "Sync" })]);

    fireEvent.click(screen.getByLabelText("Delete Sync"));

    await waitFor(() => expect(screen.queryByText("Sync")).toBeNull());
    expect(clientMock.getCloudCompatJobStatus).not.toHaveBeenCalled();
  });

  it("does NOT delete when the confirm dialog is dismissed", async () => {
    window.confirm = () => false;
    await renderWithAgents([agent({ agent_name: "Sync" })]);

    fireEvent.click(screen.getByLabelText("Delete Sync"));

    expect(clientMock.deleteCloudCompatAgent).not.toHaveBeenCalled();
    expect(screen.queryByText("Sync")).not.toBeNull();
  });
});

describe("CloudAgentsSection load state (error vs empty)", () => {
  beforeEach(() => {
    appMock.value = { elizaCloudConnected: true, setActionNotice: vi.fn() };
    resetClientMocks();
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:other",
      label: "Other",
      accessToken: "tok",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the empty state when the fetch succeeds with no agents", async () => {
    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [],
    });
    render(<CloudAgentsSection />);

    await waitFor(() =>
      expect(screen.getByTestId("cloud-agents-empty")).toBeTruthy(),
    );
    expect(screen.queryByTestId("cloud-agents-error")).toBeNull();
  });

  it("shows a distinct error state (not empty) when the fetch reports failure", async () => {
    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: false,
      data: [],
      error: "Cloud unreachable",
    });
    render(<CloudAgentsSection />);

    await waitFor(() =>
      expect(screen.getByTestId("cloud-agents-error")).toBeTruthy(),
    );
    expect(screen.getByText("Cloud unreachable")).toBeTruthy();
    // The empty-state copy must NOT be shown for a failed fetch.
    expect(screen.queryByTestId("cloud-agents-empty")).toBeNull();
  });

  it("shows the error state when the fetch throws", async () => {
    clientMock.getCloudCompatAgents.mockRejectedValue(new Error("boom net"));
    render(<CloudAgentsSection />);

    await waitFor(() =>
      expect(screen.getByTestId("cloud-agents-error")).toBeTruthy(),
    );
    expect(screen.getByText("boom net")).toBeTruthy();
  });

  it("retries the fetch from the error state", async () => {
    clientMock.getCloudCompatAgents
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "Cloud unreachable",
      })
      .mockResolvedValueOnce({ success: true, data: [agent()] });
    render(<CloudAgentsSection />);

    await waitFor(() =>
      expect(screen.getByTestId("cloud-agents-error")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("cloud-agents-error-retry"));

    await waitFor(() =>
      expect(screen.getByTestId("cloud-agent-rename-agent-1")).toBeTruthy(),
    );
    expect(screen.queryByTestId("cloud-agents-error")).toBeNull();
  });
});

// The shared→dedicated handoff no longer drives this Settings row's "Waking…"
// badge: PR3 re-points the live client SILENTLY (no row-level waking state), and
// the in-flight progress is shown by the in-chat boot-recovery card and the
// home-grid agent-provisioning tile. The row's only "Waking…" state is now the
// local suspended→resume flow, covered by "CloudAgentsSection waking on switch"
// above.
