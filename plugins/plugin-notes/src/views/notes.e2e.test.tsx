/**
 * Drives planner-visible Notes capabilities into the real read-only React
 * surface through one filesystem-backed service, including remount cycles.
 *
 * @vitest-environment jsdom
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportFetch = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/api/csrf-client", () => ({
  fetchWithCsrf: transportFetch,
}));

vi.mock("@elizaos/ui/api", () => ({
  client: {
    fetch: (url: string, init?: RequestInit) =>
      transportFetch(url, init).then((response: Response) => response.json()),
    onWsEvent: vi.fn(() => () => undefined),
  },
  isApiError: () => false,
}));

vi.mock("@elizaos/ui/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/ui/events")>();
  return { ...actual, useViewEvent: vi.fn() };
});

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: (definition: { id: string; label: string }) => ({
    ref: { current: null },
    agentProps: {
      "aria-label": definition.label,
      "data-agent-id": definition.id,
    },
  }),
}));

vi.mock(
  "@elizaos/ui/components/shared/ViewHeader",
  () => import("../../../../packages/ui/src/components/shared/ViewHeader.tsx"),
);

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

function activeService(): NotesService {
  if (!service) throw new Error("Notes E2E service is unavailable.");
  return service;
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
  it("projects note mutations across read-only view remounts", async () => {
    const notes = render(<NotesView />);
    expect(
      await screen.findByRole("main", {
        name: "Notes. 0 notes.",
      }),
    ).toBeTruthy();
    expect(
      notes.container.querySelector(
        '[data-testid="simple-notes-scroll-region"] button, input, textarea, form',
      ),
    ).toBeNull();
    notes.unmount();

    await interactWithService(
      "create-note",
      {
        content: "Demo briefing\nKeep the note wall durable",
        color: "green",
      },
      activeService(),
    );
    await interactWithService(
      "update-note",
      {
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
    expect(
      populatedNotes.container.querySelector(
        '[data-testid="simple-notes-scroll-region"] button, input, textarea, form',
      ),
    ).toBeNull();
    populatedNotes.unmount();
    render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();
    expect(screen.getByText("Keep the note wall durable")).toBeTruthy();

    await waitFor(() => {
      expect(activeService().snapshot()).toMatchObject({
        revision: 2,
        notes: [{ title: "Demo briefing ready", color: "green" }],
      });
    });
  });
});
