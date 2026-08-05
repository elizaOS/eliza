/**
 * Drives the real Notes React surface through the production browser
 * contracts into one filesystem-backed service, including remount cycles.
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
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportFetch = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/api/csrf-client", () => ({
  fetchWithCsrf: transportFetch,
}));

vi.mock("@elizaos/ui/api", () => ({
  client: { onWsEvent: vi.fn(() => () => undefined) },
}));

vi.mock("@elizaos/ui/events", () => ({
  useViewEvent: vi.fn(),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: (definition: { id: string; label: string }) => ({
    ref: { current: null },
    agentProps: {
      "aria-label": definition.label,
      "data-agent-id": definition.id,
    },
  }),
}));

import { interact as interactWithService } from "../interact.js";
import { NotesService } from "../service.js";
import { NotesView } from "./NotesView.js";

let service: NotesService | null = null;
let stateDirectory = "";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
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
      if (!service) throw new Error("Notes E2E service is unavailable.");
      if (url === "/api/notes/state") {
        return jsonResponse({ success: true, data: service.snapshot() });
      }
      if (url.startsWith("/api/views/") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          capability: string;
          params?: Record<string, unknown>;
        };
        const result = await interactWithService(
          body.capability,
          body.params,
          service,
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

describe("Notes deterministic UI-to-service journey", () => {
  it("creates, edits, and preserves a note across remounts", async () => {
    const notes = render(<NotesView />);
    expect(
      await screen.findByRole("main", {
        name: "Notes. 0 notes · revision 0",
      }),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Note title"), {
      target: { value: "Demo briefing" },
    });
    fireEvent.change(screen.getByLabelText("Note details"), {
      target: { value: "Keep the note wall durable" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use green color" }));
    fireEvent.click(screen.getByRole("button", { name: "Create note" }));

    expect(await screen.findByText("Demo briefing")).toBeTruthy();
    expect(screen.getByText("Keep the note wall durable")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit note Demo briefing" }),
    );
    fireEvent.change(screen.getByLabelText("Note title"), {
      target: { value: "Demo briefing ready" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note changes" }));
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();

    notes.unmount();
    render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();

    await waitFor(() => {
      expect(service?.snapshot()).toMatchObject({
        revision: 2,
        notes: [{ title: "Demo briefing ready", color: "green" }],
      });
    });
  });
});
