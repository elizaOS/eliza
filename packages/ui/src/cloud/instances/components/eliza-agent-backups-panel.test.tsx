/**
 * Verifies backup-list and restore UI state against deterministic mocked Cloud
 * transport responses, including request races and abort ownership.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaAgentBackupsPanel } from "./eliza-agent-backups-panel";

const apiMock = vi.hoisted(() => vi.fn());
const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: toastMocks }));

const BACKUP = {
  id: "11111111-1111-4111-8111-111111111111",
  snapshotType: "manual",
  sizeBytes: 2048,
  createdAt: "2026-08-11T12:00:00.000Z",
  backupKind: "full",
  parentBackupId: null,
};

const OLD_BACKUP = {
  ...BACKUP,
  id: "22222222-2222-4222-8222-222222222222",
  snapshotType: "pre-move",
  sizeBytes: null,
  createdAt: "2026-08-10T12:00:00.000Z",
};

function listResponse(data: unknown[] = [BACKUP]) {
  return { success: true, data };
}

function restoreResponse(backup = BACKUP) {
  return {
    success: true,
    data: {
      restoredFromBackupId: backup.id,
      snapshotType: backup.snapshotType,
      createdAt: backup.createdAt,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderPanel(
  props: Partial<{
    agentId: string;
    agentName: string;
    status: string;
  }> = {},
) {
  return render(
    <ElizaAgentBackupsPanel
      agentId={props.agentId ?? "agent-1"}
      agentName={props.agentName ?? "Primary agent"}
      status={props.status ?? "running"}
    />,
  );
}

describe("ElizaAgentBackupsPanel", () => {
  const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "location",
  );
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    apiMock.mockReset();
    toastMocks.error.mockReset();
    toastMocks.success.mockReset();
    reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    if (originalLocationDescriptor) {
      Object.defineProperty(window, "location", originalLocationDescriptor);
    }
  });

  it("keeps loading distinct until the backup request settles", async () => {
    const request = deferred<ReturnType<typeof listResponse>>();
    apiMock.mockReturnValue(request.promise);

    renderPanel();

    expect(screen.getByRole("status").textContent).toContain("Loading backups");
    expect(screen.queryByText("No backups yet")).toBeNull();

    await act(async () => {
      request.resolve(listResponse([]));
      await request.promise;
    });

    expect(await screen.findByText("No backups yet")).toBeTruthy();
  });

  it("renders the designed empty state without treating it as an error", async () => {
    apiMock.mockResolvedValue(listResponse([]));

    renderPanel();

    expect(await screen.findByText("No backups yet")).toBeTruthy();
    expect(screen.queryByText("Failed to load backups")).toBeNull();
  });

  it("renders request failures with a retry instead of an empty list", async () => {
    apiMock.mockRejectedValue(new Error("Backup service unavailable"));

    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Failed to load backups");
    expect(alert.textContent).toContain("Backup service unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No backups yet")).toBeNull();
  });

  it("uses the authenticated Cloud transport and surfaces a rejected session", async () => {
    apiMock.mockRejectedValue(
      Object.assign(new Error("Session expired"), { status: 401 }),
    );

    renderPanel({ agentId: "agent-session" });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Session expired",
    );
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/eliza/agents/agent-session/backups",
      expect.objectContaining({ cache: "no-store", signal: expect.anything() }),
    );
  });

  it.each([
    ["missing data", { success: true }],
    ["false success", { success: false, data: [] }],
    ["missing id", listResponse([{ ...BACKUP, id: undefined }])],
    [
      "unknown snapshot type",
      listResponse([{ ...BACKUP, snapshotType: "before-party" }]),
    ],
    ["negative size", listResponse([{ ...BACKUP, sizeBytes: -1 }])],
    ["invalid timestamp", listResponse([{ ...BACKUP, createdAt: "soon" }])],
  ])("renders malformed success (%s) as an error", async (_name, payload) => {
    apiMock.mockResolvedValue(payload);

    renderPanel();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No backups yet")).toBeNull();
  });

  it("accepts every backend snapshot category", async () => {
    apiMock.mockResolvedValue(
      listResponse([
        {
          ...BACKUP,
          id: "55555555-5555-4555-8555-555555555555",
          snapshotType: "auto",
        },
        BACKUP,
        {
          ...BACKUP,
          id: "66666666-6666-4666-8666-666666666666",
          snapshotType: "pre-shutdown",
        },
        {
          ...BACKUP,
          id: "77777777-7777-4777-8777-777777777777",
          snapshotType: "pre-delete",
        },
        OLD_BACKUP,
        {
          ...BACKUP,
          id: "33333333-3333-4333-8333-333333333333",
          snapshotType: "pre-upgrade",
        },
      ]),
    );

    renderPanel();

    expect(await screen.findByText("Auto")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Pre-shutdown")).toBeTruthy();
    expect(screen.getByText("Pre-delete")).toBeTruthy();
    expect(await screen.findByText("Pre-move")).toBeTruthy();
    expect(screen.getByText("Pre-upgrade")).toBeTruthy();
  });

  it("aborts the previous agent request and ignores its late response", async () => {
    const oldRequest = deferred<ReturnType<typeof listResponse>>();
    let oldSignal: AbortSignal | undefined;
    apiMock.mockImplementation(
      (path: string, init?: { signal?: AbortSignal }) => {
        if (path.includes("agent-old")) {
          oldSignal = init?.signal;
          return oldRequest.promise;
        }
        return Promise.resolve(
          listResponse([
            {
              ...BACKUP,
              id: "44444444-4444-4444-8444-444444444444",
            },
          ]),
        );
      },
    );

    const view = renderPanel({ agentId: "agent-old" });
    view.rerender(
      <ElizaAgentBackupsPanel
        agentId="agent-new"
        agentName="New agent"
        status="running"
      />,
    );

    expect(await screen.findByText("Backup ID: 44444444")).toBeTruthy();
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      oldRequest.resolve(listResponse([OLD_BACKUP]));
      await oldRequest.promise;
    });

    expect(screen.queryByText("Backup ID: 22222222")).toBeNull();
    expect(screen.getByText("Backup ID: 44444444")).toBeTruthy();
  });

  it("hides the previous agent's backups before the replacement request settles", async () => {
    const nextRequest = deferred<ReturnType<typeof listResponse>>();
    apiMock.mockImplementation((path: string) =>
      path.includes("agent-new")
        ? nextRequest.promise
        : Promise.resolve(listResponse()),
    );

    const view = renderPanel({ agentId: "agent-old" });
    expect(await screen.findByText("Backup ID: 11111111")).toBeTruthy();

    view.rerender(
      <ElizaAgentBackupsPanel
        agentId="agent-new"
        agentName="New agent"
        status="running"
      />,
    );

    expect(screen.queryByText("Backup ID: 11111111")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading backups");

    await act(async () => {
      nextRequest.resolve(listResponse([]));
      await nextRequest.promise;
    });
    expect(await screen.findByText("No backups yet")).toBeTruthy();
  });

  it("aborts an in-flight list request when the panel unmounts", () => {
    let signal: AbortSignal | undefined;
    apiMock.mockImplementation(
      (_path: string, init?: { signal?: AbortSignal }) => {
        signal = init?.signal;
        return new Promise(() => undefined);
      },
    );

    const view = renderPanel();
    view.unmount();

    expect(signal?.aborted).toBe(true);
  });

  it("requires explicit confirmation and cancel performs no restore", async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue(listResponse());
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Restore latest" }),
    );

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Restore this backup?")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("hides historical restore actions when an agent is stopped", async () => {
    apiMock.mockResolvedValue(listResponse([OLD_BACKUP, BACKUP]));

    renderPanel({ status: "sleeping" });

    expect(
      await screen.findByText("Historical restores require a running agent."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Restore this backup" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Restore latest" })).toBeTruthy();
  });

  it("keeps restore failures visible inside the confirmation dialog", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/restore")) {
        return Promise.reject(new Error("Restore bridge unavailable"));
      }
      return Promise.resolve(listResponse());
    });
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Restore latest" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Restore backup" }),
    );

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Restore bridge unavailable",
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(toastMocks.error).toHaveBeenCalledWith("Restore bridge unavailable");
  });

  it("rejects a malformed restore success and does not refresh the list", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/restore")
          ? { success: true, data: {} }
          : listResponse(),
      ),
    );
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Restore latest" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Restore backup" }),
    );

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Restore response contained an invalid backup result",
    );
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("shows restore progress, refreshes after success, and never reloads the page", async () => {
    const user = userEvent.setup();
    const restoreRequest = deferred<ReturnType<typeof restoreResponse>>();
    apiMock.mockImplementation((path: string) =>
      path.endsWith("/restore")
        ? restoreRequest.promise
        : Promise.resolve(listResponse()),
    );
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Restore latest" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Restore backup" }),
    );

    expect(
      within(dialog)
        .getByRole("button", { name: "Restoring…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(apiMock).toHaveBeenLastCalledWith(
      "/api/v1/eliza/agents/agent-1/restore",
      expect.objectContaining({
        method: "POST",
        json: { backupId: BACKUP.id },
        signal: expect.anything(),
      }),
    );

    await act(async () => {
      restoreRequest.resolve(restoreResponse());
      await restoreRequest.promise;
    });

    expect(
      await screen.findByText("Backup restored successfully."),
    ).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Backup restored successfully.",
    );
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("aborts a restore when the agent changes and suppresses stale success", async () => {
    const user = userEvent.setup();
    const restoreRequest = deferred<ReturnType<typeof restoreResponse>>();
    let restoreSignal: AbortSignal | undefined;
    apiMock.mockImplementation(
      (path: string, init?: { signal?: AbortSignal }) => {
        if (path.endsWith("/restore")) {
          restoreSignal = init?.signal;
          return restoreRequest.promise;
        }
        if (path.includes("agent-new"))
          return Promise.resolve(listResponse([]));
        return Promise.resolve(listResponse());
      },
    );
    const view = renderPanel({ agentId: "agent-old" });

    await user.click(
      await screen.findByRole("button", { name: "Restore latest" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Restore backup",
      }),
    );
    view.rerender(
      <ElizaAgentBackupsPanel
        agentId="agent-new"
        agentName="New agent"
        status="running"
      />,
    );

    expect(await screen.findByText("No backups yet")).toBeTruthy();
    expect(restoreSignal?.aborted).toBe(true);
    await act(async () => {
      restoreRequest.resolve(restoreResponse());
      await restoreRequest.promise;
    });

    expect(screen.queryByText("Backup restored successfully.")).toBeNull();
    expect(toastMocks.success).not.toHaveBeenCalled();
  });
});
