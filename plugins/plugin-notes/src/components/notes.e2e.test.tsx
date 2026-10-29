/**
 * Drives planner-visible Notes capabilities into the shared editable React
 * surface through one filesystem-backed service, including remount cycles.
 *
 * @vitest-environment jsdom
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportFetch = vi.hoisted(() => vi.fn());
const activeAuthority = vi.hoisted(() => ({ value: "notes-owner-a" }));

vi.mock("../../../../packages/ui/src/api/csrf-client", () => ({
  fetchWithCsrf: transportFetch,
}));

vi.mock("@elizaos/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/ui")>()),
  ...(await (async (importOriginal) => ({
    ...(await importOriginal<typeof import("@elizaos/ui")>()),
    client: {
      fetch: (url: string, init?: RequestInit) =>
        transportFetch(url, init).then((response: Response) => response.json()),
      onWsEvent: vi.fn(() => () => undefined),
    },
    isApiError: () => false,
  }))(importOriginal)),
  useViewEvent: vi.fn(),
  useActiveAgentAuthority: () => activeAuthority.value,
  getActiveAgentAuthority: () => activeAuthority.value,
  useAgentElement: (definition: { id: string; label: string }) => ({
    ref: { current: null },
    agentProps: {
      "aria-label": definition.label,
      "data-agent-id": definition.id,
    },
  }),
}));

vi.mock(
  "../../../../packages/ui/src/components/shared/ViewHeader",
  () => import("../../../../packages/ui/src/components/shared/ViewHeader"),
);

import { ApiError } from "../../../../packages/ui/src/api/client-types-core.js";
import { createNotesClient } from "../client/notes-api.js";
import { NotesController } from "../client/notes-controller.js";
import { NotesEditor } from "../client/notes-editor.js";
import { interact as interactWithService } from "../interact.js";
import { NotesService } from "../service.js";
import { NotesView } from "./NotesView.js";
import { NotesWorkspace, type NotesWorkspaceHandle } from "./NotesWorkspace.js";

let service: NotesService | null = null;
let stateDirectory = "";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function activeService(): NotesService {
  if (!service) throw new Error("Notes E2E service is unavailable.");
  return service;
}

beforeEach(async () => {
  activeAuthority.value = "notes-owner-a";
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "notes-ui-e2e-"));
  let id = 0;
  let timestamp = Date.parse("2026-07-22T12:00:00.000Z");
  service = new NotesService(undefined, {
    stateDir: stateDirectory,
    createId: () => `note-e2e-${++id}`,
    now: () => new Date(timestamp++),
  });
  await service.initialize();

  transportFetch.mockReset();
  transportFetch.mockImplementation(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const currentService = activeService();
      if (url === "/api/notes/state") {
        return jsonResponse({ success: true, data: currentService.snapshot() });
      }
      if (url.startsWith("/api/views/") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          capability: string;
          params?: Record<string, unknown>;
        };
        const result = await interactWithService(
          body.capability,
          body.params,
          currentService,
        );
        return jsonResponse({
          requestId: `notes-e2e-${body.capability}`,
          success: result.success,
          result,
        });
      }
      return jsonResponse({ error: `Unexpected E2E URL: ${url}` }, 404);
    },
  );
});

afterEach(async () => {
  cleanup();
  await service?.stop();
  service = null;
  await fs.rm(stateDirectory, { recursive: true, force: true });
});

describe("Notes capability-to-UI journey", () => {
  function editorSession() {
    let current = true;
    let reviews = 0;
    const notes = createNotesClient({
      fetch: async <T,>(url: string, init?: RequestInit) =>
        (await transportFetch(url, init)).json() as Promise<T>,
    });
    const controller = new NotesController(notes, () => current, {
      snapshot: () => editor?.reconcile(),
      phase: () => {},
    });
    const editor = new NotesEditor(controller, {
      changed: () => {},
      committed: () => {},
      review: () => {
        reviews++;
      },
    });
    return {
      controller,
      editor,
      retire: () => {
        current = false;
        controller.retire();
      },
      reviews: () => reviews,
    };
  }

  it("shares canonical editor writes, conflicts and Trash with the real Notes service", async () => {
    const session = editorSession();
    try {
      await session.controller.refresh();
      session.editor.begin("list");
      session.editor.edit({
        title: "Exact title",
        body: "\nExact body",
        format: {
          kind: "list",
          data: {
            items: [{ id: "one", text: "Keep rich fields", done: false }],
            pinned: true,
          },
        },
      });
      expect(await session.editor.save()).toBe(true);
      const id = session.editor.draft?.id;
      expect(id).toBeTruthy();
      if (!id) throw Error("Expected canonical note identity");
      expect(activeService().snapshot().notes[0]).toMatchObject({
        title: "Exact title",
        body: "\n\nExact body",
        format: {
          kind: "list",
          data: {
            items: [{ id: "one", text: "Keep rich fields", done: false }],
            pinned: true,
          },
        },
      });
      session.editor.edit({ body: "Unsaved owner text" });
      await interactWithService(
        "update-note",
        {
          id,
          expectedRevision: activeService().snapshot().revision,
          content: "Agent edit\nKeep this",
        },
        activeService(),
      );
      await session.controller.refresh();
      expect(await session.editor.save()).toBe(false);
      expect(session.reviews()).toBeGreaterThan(0);
      expect(session.editor.draft?.body).toBe("Unsaved owner text");
      expect(activeService().snapshot().notes[0].title).toBe("Agent edit");
      session.editor.close();
      session.editor.open(id);
      expect(await session.editor.remove(id)).toBe(true);
      expect(activeService().snapshot().notes).toHaveLength(0);
      expect(await session.editor.restore(id)).toBe(true);
      expect(activeService().snapshot().notes[0].id).toBe(id);
    } finally {
      session.retire();
    }
  });

  it("retires a pending canonical read before it can publish into another owner", async () => {
    await interactWithService(
      "create-note",
      { content: "Owner's private note" },
      activeService(),
    );
    const original = transportFetch.getMockImplementation();
    if (!original) throw Error("Expected Notes service transport");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    transportFetch.mockImplementationOnce(
      async (url: string, init?: RequestInit) => {
        const response = await original(url, init);
        await waiting;
        return response;
      },
    );
    const session = editorSession();
    const read = session.controller.refresh();
    session.retire();
    release();
    await expect(read).rejects.toBeTruthy();
    expect(session.controller.snapshot).toBeNull();
    expect(session.editor.draft).toBeNull();
  });

  it("projects planner and editor mutations through the same persisted identity", async () => {
    const notes = render(<NotesView />);
    expect(
      await screen.findByRole("main", {
        name: "Notes. 0 notes.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "New note" })).toBeTruthy();
    notes.unmount();

    await interactWithService(
      "create-note",
      {
        content: "Demo briefing\nKeep the note wall durable",
        color: "green",
      },
      activeService(),
    );
    const originalSnapshot = activeService().snapshot();
    await interactWithService(
      "update-note",
      {
        expectedRevision: originalSnapshot.revision,
        query: "Demo briefing",
        content: "Demo briefing ready\nKeep the note wall durable",
      },
      activeService(),
    );

    const populatedNotes = render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();
    expect(screen.getByText("Keep the note wall durable")).toBeTruthy();
    expect(
      screen
        .getByLabelText("Note Demo briefing ready")
        .getAttribute("data-agent-id"),
    ).toBe("note-e2e-1");
    fireEvent.click(
      screen.getByRole("button", { name: "Note Demo briefing ready" }),
    );
    const body = await screen.findByRole("textbox", {
      name: "Note",
    });
    fireEvent.change(body, {
      target: { value: "Owner edit\nExact second line" },
    });
    await waitFor(() =>
      expect(activeService().snapshot().notes[0].body).toBe(
        "\nOwner edit\nExact second line",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull(),
    );
    populatedNotes.unmount();
    render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();
    expect(screen.getByText(/Owner edit/)).toBeTruthy();

    await waitFor(() => {
      expect(activeService().snapshot()).toMatchObject({
        revision: 3,
        notes: [{ title: "Demo briefing ready", color: "green" }],
      });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Note Demo briefing ready" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete note" }));
    await waitFor(() =>
      expect(activeService().snapshot().notes).toHaveLength(0),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Trash" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Restore Demo briefing ready",
      }),
    );
    await waitFor(() =>
      expect(activeService().snapshot().notes[0].id).toBe("note-e2e-1"),
    );
  });

  it("retains a failed editor draft and does not retry it when reads recover", async () => {
    await interactWithService(
      "create-note",
      { content: "Stable note\nOriginal" },
      activeService(),
    );
    render(<NotesView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Note Stable note" }),
    );
    const original = transportFetch.getMockImplementation();
    let writes = 0;
    transportFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes++;
        throw new TypeError("Failed to fetch");
      }
      return original?.(url, init);
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Note" }), {
      target: { value: "Keep this unsaved text" },
    });
    await screen.findByRole("button", { name: "Discard draft and reload" });
    expect(writes).toBe(1);
    expect(activeService().snapshot().notes[0].body).toBe("\nOriginal");
    fireEvent(window, new Event("online"));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Note" })).toHaveProperty(
        "value",
        "Keep this unsaved text",
      ),
    );
    expect(writes).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Discard draft and reload" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Note" })).toHaveProperty(
        "value",
        "Original",
      ),
    );
    expect(writes).toBe(1);
  });
  it("edits an authored voice action while preserving opaque media metadata", async () => {
    await interactWithService(
      "create-note",
      {
        content: "Meeting record",
        format: {
          kind: "voice",
          data: {
            lines: [{ t: "Exact spoken words", s: "owner" }],
            summary: ["Reviewed summary"],
            actions: [
              { t: "Review the document", done: false, source: "kept" },
            ],
            audio: { audioId: "local-audio-id" },
          },
        },
      },
      activeService(),
    );
    render(<NotesView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Note Meeting record" }),
    );
    expect(
      within(
        await screen.findByRole("region", { name: "Transcript and summary" }),
      ).getByText("Exact spoken words", { exact: false }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Check Review the document" }),
    );
    await waitFor(() =>
      expect(activeService().snapshot().notes[0].format?.data.actions).toEqual([
        { t: "Review the document", done: true, source: "kept" },
      ]),
    );
    expect(activeService().snapshot().notes[0].format?.data.audio).toEqual({
      audioId: "local-audio-id",
    });
  });

  it("finishes an admitted save without starting a share after the workspace hides", async () => {
    await interactWithService(
      "create-note",
      { content: "Shared note\nOriginal" },
      activeService(),
    );
    const original = transportFetch.getMockImplementation();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    transportFetch.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") await pending;
        return original?.(url, init);
      },
    );
    const props = {
      client: createNotesClient({
        fetch: (url: string, init?: RequestInit) =>
          transportFetch(url, init).then((response: Response) =>
            response.json(),
          ),
      }),
      binding: { key: "share-owner", current: () => true },
      ports: { share: vi.fn(async () => {}) },
    };
    const view = render(<NotesWorkspace {...props} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Note Shared note" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Saved while hidden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    view.rerender(<NotesWorkspace {...props} active={false} />);
    release();
    await waitFor(() =>
      expect(activeService().snapshot().notes[0].body).toBe(
        "\nSaved while hidden",
      ),
    );
    expect(props.ports.share).not.toHaveBeenCalled();
    view.rerender(<NotesWorkspace {...props} active />);
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveProperty(
      "value",
      "Saved while hidden",
    );
  });

  it("hands the selected note to the host's reviewed Calendar and reminder draft ports", async () => {
    await interactWithService(
      "create-note",
      { content: "Venue plan\nBook the venue" },
      activeService(),
    );
    const draftEvent = vi.fn(async () => {});
    const draftReminder = vi.fn(async () => {
      throw new Error("Calendar unavailable");
    });
    render(
      <NotesWorkspace
        client={createNotesClient({
          fetch: (url: string, init?: RequestInit) =>
            transportFetch(url, init).then((response: Response) =>
              response.json(),
            ),
        })}
        binding={{ key: "draft-owner", current: () => true }}
        ports={{ draftEvent, draftReminder }}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Note Venue plan" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Calendar draft" }));
    await waitFor(() => expect(draftEvent).toHaveBeenCalledTimes(1));
    expect(draftEvent.mock.calls[0][0]).toMatchObject({
      title: "Venue plan",
      body: "Book the venue",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reminder draft" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reminder draft" }));
    expect(
      await screen.findByText(
        "The draft could not be opened. Nothing was scheduled.",
      ),
    ).toBeTruthy();
    expect(activeService().snapshot().notes[0].body).toBe("Book the venue");
  });

  it("saves a Home card before Notes has ever been opened without navigating", async () => {
    const workspace = createRef<NotesWorkspaceHandle>();
    let receipt: { id: string; revision: number } | undefined;
    const client = createNotesClient({
      fetch: (url: string, init?: RequestInit) =>
        transportFetch(url, init).then((response: Response) => response.json()),
    });
    render(
      <>
        <main aria-label="Home">
          <button
            type="button"
            onClick={() =>
              void workspace.current
                ?.interact("create-note", {
                  content: "Before first open\nExact card body",
                })
                .then((result) => {
                  receipt = result.target;
                })
            }
          >
            Save card to Notes
          </button>
        </main>
        <section hidden>
          <NotesWorkspace
            ref={workspace}
            active={false}
            client={client}
            binding={{ key: "cold-home-owner", current: () => true }}
          />
        </section>
      </>,
    );
    await waitFor(() => expect(workspace.current?.current()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Save card to Notes" }));
    await waitFor(() => expect(receipt).toBeDefined());
    const state = activeService().snapshot();
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].body).toBe("\nExact card body");
    expect(receipt).toEqual({
      id: state.notes[0].id,
      revision: state.revision,
    });
    expect(
      transportFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(screen.getByRole("main", { name: "Home" })).toBeTruthy();
    expect(screen.queryByRole("main", { name: /^Notes\./ })).toBeNull();
  });

  it("saves one explicit Home card through the hidden workspace and retains its dirty draft", async () => {
    await interactWithService(
      "create-note",
      { content: "Existing draft\nOriginal" },
      activeService(),
    );
    const original = transportFetch.getMockImplementation();
    let failUpdate = true;
    let creates = 0;
    transportFetch.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const request = JSON.parse(String(init.body));
          if (request.capability === "create-note") creates++;
          if (request.capability === "update-note" && failUpdate)
            throw new TypeError("Failed to fetch");
        }
        return original?.(url, init);
      },
    );
    const workspace = createRef<NotesWorkspaceHandle>();
    const client = createNotesClient({
      fetch: (url: string, init?: RequestInit) =>
        transportFetch(url, init).then((response: Response) => response.json()),
    });
    const binding = { key: "home-card-owner", current: () => true };
    function HomeCardHost({ active }: { active: boolean }) {
      const [receipt, setReceipt] = useState<{
        id: string;
        revision: number;
      }>();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              void workspace.current
                ?.interact("create-note", {
                  content: "From Home\nExact saved card text",
                })
                .then((result) => setReceipt(result.target))
            }
          >
            Save card to Notes
          </button>
          <output aria-label="Save receipt">
            {receipt ? `${receipt.id}:${receipt.revision}` : "Not saved"}
          </output>
          <section hidden={!active}>
            <NotesWorkspace
              ref={workspace}
              active={active}
              client={client}
              binding={binding}
            />
          </section>
        </>
      );
    }
    const view = render(<HomeCardHost active />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Note Existing draft" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Keep my unsaved editor text" },
    });
    await screen.findByRole("button", { name: "Discard draft and reload" });
    expect(workspace.current?.hasUnsavedChanges()).toBe(true);
    failUpdate = false;
    view.rerender(<HomeCardHost active={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Save card to Notes" }));
    await waitFor(() => {
      const state = activeService().snapshot();
      const note = state.notes.find((note) => note.title === "From Home");
      expect(note?.body).toBe("\nExact saved card text");
      expect(
        screen.getByRole("status", { name: "Save receipt" }).textContent,
      ).toBe(`${note?.id}:${state.revision}`);
    });
    expect(creates).toBe(1);
    expect(workspace.current?.hasUnsavedChanges()).toBe(true);
    expect(
      activeService()
        .snapshot()
        .notes.find((note) => note.title === "Existing draft")?.body,
    ).toBe("\nOriginal");
    view.rerender(<HomeCardHost active />);
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveProperty(
      "value",
      "Keep my unsaved editor text",
    );
  });

  it("preserves typed non-retryable failures and recovers on an admitted refresh", async () => {
    const original = transportFetch.getMockImplementation();
    transportFetch.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/notes/state",
        status: 503,
        code: "notes_runtime_unavailable",
        message: "Dedicated agent required",
        data: { retryable: false },
      }),
    );
    render(<NotesView />);
    await screen.findByText("Notes need a Dedicated agent");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    if (!original) throw Error("Expected filesystem service transport");
    transportFetch.mockImplementation(original);
    fireEvent(window, new Event("online"));
    await screen.findByRole("main", { name: "Notes. 0 notes." });
  });

  it("masks old-owner content and retires an old in-flight service read", async () => {
    await interactWithService(
      "create-note",
      { content: "Owner A private note" },
      activeService(),
    );
    const second = new NotesService(undefined, {
      stateDir: path.join(stateDirectory, "owner-b"),
    });
    await second.initialize();
    await interactWithService(
      "create-note",
      { content: "Owner B note" },
      second,
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    transportFetch.mockImplementation(async () => {
      const owner = activeAuthority.value;
      const snapshot =
        owner === "notes-owner-a"
          ? activeService().snapshot()
          : second.snapshot();
      if (owner === "notes-owner-a") await pending;
      return jsonResponse({ success: true, data: snapshot });
    });
    try {
      const view = render(<NotesView />);
      await waitFor(() => expect(transportFetch).toHaveBeenCalled());
      activeAuthority.value = "notes-owner-b";
      view.rerender(<NotesView />);
      expect(screen.queryByText("Owner A private note")).toBeNull();
      await screen.findByText("Owner B note");
      release();
      await pending;
      expect(screen.queryByText("Owner A private note")).toBeNull();
    } finally {
      release();
      await second.stop();
    }
  });
});
