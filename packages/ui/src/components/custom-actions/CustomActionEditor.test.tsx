// @vitest-environment jsdom
//
// Behavioral test for the custom-action editor — the app's most
// security-sensitive authoring surface (it defines HTTP/shell/JS actions the
// agent later executes). We drive the real component and assert the exact
// payload it builds and hands to the API boundary, the validation errors it
// surfaces, handler-type switching, save-idempotency, and how it treats
// adversarial (SSRF-ish / javascript: / oversized) input.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomActionDef } from "@elizaos/shared";
import { installJsdomUiPolyfills } from "../../../test/portable-stories";

// ── Collaborator mocks ────────────────────────────────────────────────
// The unit under test is CustomActionEditor + custom-action-form (NOT mocked).
// We mock only the API transport and the app-state selector.

const clientMock = vi.hoisted(() => ({
  createCustomAction: vi.fn(),
  updateCustomAction: vi.fn(),
  testCustomAction: vi.fn(),
  generateCustomAction: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (v: { t: typeof tFn }) => unknown) => sel({ t: tFn }),
}));

// t() mirrors the real i18n contract closely enough for assertions: return the
// caller-supplied defaultValue when present, otherwise the raw key.
const tFn = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

import { CustomActionEditor } from "./CustomActionEditor";

// Placeholder keys the component feeds through t() with no defaultValue, so
// they surface verbatim and give us stable input handles.
const PH_NAME = "customactioneditor.MYACTION";
const PH_DESC = "customactioneditor.WhatDoesThisActio";
const PH_URL = "customactioneditor.httpsApiExample";

function renderEditor(props?: {
  action?: CustomActionDef | null;
  onSave?: (a: CustomActionDef) => void;
  onClose?: () => void;
}) {
  const onSave = props?.onSave ?? vi.fn();
  const onClose = props?.onClose ?? vi.fn();
  render(
    <CustomActionEditor
      open
      action={props?.action ?? null}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  return { onSave, onClose };
}

const nameInput = () => screen.getByPlaceholderText(PH_NAME) as HTMLInputElement;
const descInput = () =>
  screen.getByPlaceholderText(PH_DESC) as HTMLTextAreaElement;
const urlInput = () => screen.getByPlaceholderText(PH_URL) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "common.save" });

beforeEach(() => {
  installJsdomUiPolyfills();
  clientMock.createCustomAction.mockReset();
  clientMock.updateCustomAction.mockReset();
  clientMock.testCustomAction.mockReset();
  clientMock.generateCustomAction.mockReset();
  // Default: create echoes back a persisted record with an id.
  clientMock.createCustomAction.mockImplementation(
    async (def: Omit<CustomActionDef, "id" | "createdAt" | "updatedAt">) => ({
      ...def,
      id: "new-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  );
});

afterEach(() => cleanup());

describe("CustomActionEditor — validation gates", () => {
  it("blocks save with an empty name and shows the required-name error", async () => {
    renderEditor();
    fireEvent.click(saveButton());
    await screen.findByText("Name is required.");
    expect(clientMock.createCustomAction).not.toHaveBeenCalled();
  });

  it("blocks save when description is empty", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "PING" } });
    fireEvent.click(saveButton());
    await screen.findByText("Description is required.");
    expect(clientMock.createCustomAction).not.toHaveBeenCalled();
  });

  it("blocks an HTTP action save when the URL is empty", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "PING" } });
    fireEvent.change(descInput(), { target: { value: "pings a host" } });
    fireEvent.click(saveButton());
    await screen.findByText("HTTP URL is required.");
    expect(clientMock.createCustomAction).not.toHaveBeenCalled();
  });

  it("blocks a shell action save when the command is empty", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "RUN" } });
    fireEvent.change(descInput(), { target: { value: "runs a command" } });
    fireEvent.click(screen.getByText("Shell Command"));
    fireEvent.click(saveButton());
    await screen.findByText("Shell command is required.");
    expect(clientMock.createCustomAction).not.toHaveBeenCalled();
  });

  it("blocks a code action save when the code is empty", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "EVAL" } });
    fireEvent.change(descInput(), { target: { value: "evaluates js" } });
    fireEvent.click(screen.getByText("JavaScript"));
    fireEvent.click(saveButton());
    await screen.findByText("Code is required.");
    expect(clientMock.createCustomAction).not.toHaveBeenCalled();
  });
});

describe("CustomActionEditor — save builds the correct payload", () => {
  it("creates an HTTP action with the exact handler payload and calls onSave with the persisted record", async () => {
    const { onSave } = renderEditor();
    fireEvent.change(nameInput(), { target: { value: "check status" } });
    fireEvent.change(descInput(), {
      target: { value: "Pings a website" },
    });
    // Aliases -> normalized, comma-split similes.
    fireEvent.change(screen.getByPlaceholderText("customactioneditor.SYNONYMONESYNONYM"), {
      target: { value: "ping site, website status" },
    });
    fireEvent.change(urlInput(), {
      target: { value: "https://api.example.com/status" },
    });

    fireEvent.click(saveButton());

    await vi.waitFor(() =>
      expect(clientMock.createCustomAction).toHaveBeenCalledTimes(1),
    );
    const def = clientMock.createCustomAction.mock.calls[0][0];
    expect(def).toEqual({
      name: "CHECK_STATUS", // normalizeActionName: upper + underscores
      description: "Pings a website",
      similes: ["PING_SITE", "WEBSITE_STATUS"],
      parameters: [],
      handler: {
        type: "http",
        method: "GET",
        url: "https://api.example.com/status",
        headers: undefined, // no header rows filled -> omitted
        bodyTemplate: undefined,
      },
      enabled: true,
    });
    expect(clientMock.updateCustomAction).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].id).toBe("new-1");
  });

  it("only includes headers whose key is non-empty", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "AUTHED" } });
    fireEvent.change(descInput(), { target: { value: "authed call" } });
    fireEvent.change(urlInput(), {
      target: { value: "https://api.example.com" },
    });
    // Fill the pre-existing (empty) header row's key + value.
    fireEvent.change(screen.getByPlaceholderText("customactioneditor.HeaderName"), {
      target: { value: "Authorization" },
    });
    fireEvent.change(screen.getByPlaceholderText("customactioneditor.valueOrParam"), {
      target: { value: "Bearer {{token}}" },
    });

    fireEvent.click(saveButton());
    await vi.waitFor(() =>
      expect(clientMock.createCustomAction).toHaveBeenCalledTimes(1),
    );
    const def = clientMock.createCustomAction.mock.calls[0][0];
    expect(def.handler.headers).toEqual({ Authorization: "Bearer {{token}}" });
  });

  it("switches to shell and persists a shell handler (HTTP fields removed from DOM)", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "DISK" } });
    fireEvent.change(descInput(), { target: { value: "disk usage" } });

    fireEvent.click(screen.getByText("Shell Command"));
    // HTTP url field is gone once we leave the http tab.
    expect(screen.queryByPlaceholderText(PH_URL)).toBeNull();

    const cmd = screen.getByPlaceholderText(
      "customactioneditor.echoMessage",
    ) as HTMLTextAreaElement;
    fireEvent.change(cmd, { target: { value: "df -h {{path}}" } });

    fireEvent.click(saveButton());
    await vi.waitFor(() =>
      expect(clientMock.createCustomAction).toHaveBeenCalledTimes(1),
    );
    expect(clientMock.createCustomAction.mock.calls[0][0].handler).toEqual({
      type: "shell",
      command: "df -h {{path}}",
    });
  });

  it("switches to JavaScript and persists a code handler", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "SUM" } });
    fireEvent.change(descInput(), { target: { value: "adds numbers" } });

    fireEvent.click(screen.getByText("JavaScript"));
    const codeArea = screen.getByPlaceholderText(
      "customactioneditor.AvailableParams",
    ) as HTMLTextAreaElement;
    fireEvent.change(codeArea, { target: { value: "return params.a + params.b" } });

    fireEvent.click(saveButton());
    await vi.waitFor(() =>
      expect(clientMock.createCustomAction).toHaveBeenCalledTimes(1),
    );
    expect(clientMock.createCustomAction.mock.calls[0][0].handler).toEqual({
      type: "code",
      code: "return params.a + params.b",
    });
  });

  it("edits an existing action via updateCustomAction(id, ...), not create", async () => {
    const existing: CustomActionDef = {
      id: "act-42",
      name: "EXISTING",
      description: "old desc",
      similes: [],
      parameters: [],
      handler: { type: "http", method: "GET", url: "https://old.example.com" },
      enabled: false,
      createdAt: "x",
      updatedAt: "y",
    };
    clientMock.updateCustomAction.mockResolvedValue({
      ...existing,
      description: "new desc",
    });
    renderEditor({ action: existing });

    fireEvent.change(descInput(), { target: { value: "new desc" } });
    fireEvent.click(saveButton());

    await vi.waitFor(() =>
      expect(clientMock.updateCustomAction).toHaveBeenCalledTimes(1),
    );
    const [id, def] = clientMock.updateCustomAction.mock.calls[0];
    expect(id).toBe("act-42");
    // enabled is preserved from the existing action (false), not reset to true.
    expect(def.enabled).toBe(false);
    expect(def.description).toBe("new desc");
    expect(clientMock.createCustomAction).not.toHaveBeenCalled();
  });

  it("surfaces a transport failure as a form error and does not call onSave", async () => {
    clientMock.createCustomAction.mockRejectedValueOnce(new Error("boom"));
    const { onSave } = renderEditor();
    fireEvent.change(nameInput(), { target: { value: "PING" } });
    fireEvent.change(descInput(), { target: { value: "pings" } });
    fireEvent.change(urlInput(), { target: { value: "https://x.example.com" } });

    fireEvent.click(saveButton());
    await screen.findByText("Failed to save: boom");
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("CustomActionEditor — adversarial input (observable outcome)", () => {
  // The editor is authoring UI; it performs NO client-side SSRF/scheme guard.
  // These assert the real observable contract: dangerous URLs are forwarded to
  // the API verbatim (server-side execution is where the guard must live).
  it.each([
    ["http://localhost:9200/_shutdown"],
    ["http://169.254.169.254/latest/meta-data/"],
    ["http://127.0.0.1:6379"],
    ["javascript:fetch('http://evil')"],
    ["file:///etc/passwd"],
  ])("forwards adversarial URL %s unchanged to the API", async (badUrl) => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "PROBE" } });
    fireEvent.change(descInput(), { target: { value: "probe" } });
    fireEvent.change(urlInput(), { target: { value: badUrl } });

    fireEvent.click(saveButton());
    await vi.waitFor(() =>
      expect(clientMock.createCustomAction).toHaveBeenCalledTimes(1),
    );
    expect(clientMock.createCustomAction.mock.calls[0][0].handler.url).toBe(
      badUrl,
    );
    cleanup();
  });

  it("treats a whitespace-only URL as empty and blocks the save", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "PING" } });
    fireEvent.change(descInput(), { target: { value: "pings" } });
    fireEvent.change(urlInput(), { target: { value: "   \t  " } });
    fireEvent.click(saveButton());
    await screen.findByText("HTTP URL is required.");
    expect(clientMock.createCustomAction).not.toHaveBeenCalled();
  });

  it("caps an oversized name at 256 chars and normalizes it", () => {
    renderEditor();
    const huge = "a".repeat(5000);
    fireEvent.change(nameInput(), { target: { value: huge } });
    // normalizeActionName slices to 256 then uppercases -> 256 'A's.
    expect(nameInput().value).toBe("A".repeat(256));
  });

  it("normalizes an unsafe name in the DOM (round-trip) — no spaces/punctuation leak", () => {
    renderEditor();
    fireEvent.change(nameInput(), {
      target: { value: "rm -rf /; drop table" },
    });
    // Non-[A-Z0-9_] runs collapse to single underscores, trimmed at ends.
    expect(nameInput().value).toBe("RM_RF_DROP_TABLE");
  });
});

describe("CustomActionEditor — idempotency", () => {
  it("does not double-submit when Save is clicked twice in quick succession", async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: "PING" } });
    fireEvent.change(descInput(), { target: { value: "pings" } });
    fireEvent.change(urlInput(), { target: { value: "https://x.example.com" } });

    const btn = saveButton();
    fireEvent.click(btn);
    fireEvent.click(btn);

    await vi.waitFor(() =>
      expect(clientMock.createCustomAction).toHaveBeenCalled(),
    );
    // The `saving` guard + disabled button must collapse the burst to one call.
    expect(clientMock.createCustomAction).toHaveBeenCalledTimes(1);
  });
});

describe("CustomActionEditor — Test flow (save-then-execute)", () => {
  it("executes a saved action against testCustomAction with the entered params and renders output", async () => {
    const saved: CustomActionDef = {
      id: "act-test-1",
      name: "PINGER",
      description: "pings",
      similes: [],
      parameters: [{ name: "host", description: "host", required: true }],
      handler: { type: "http", method: "GET", url: "https://x.example.com" },
      enabled: true,
      createdAt: "x",
      updatedAt: "y",
    };
    clientMock.testCustomAction.mockResolvedValue({
      ok: true,
      output: "pong",
      durationMs: 5,
    });
    // Editing an existing action -> Test uses its id directly (no auto-save).
    renderEditor({ action: saved });

    // Expand the Test section.
    fireEvent.click(screen.getByText("customactioneditor.TestAction"));
    // Enter a value for the "host" param.
    const paramInput = screen.getByPlaceholderText("host") as HTMLInputElement;
    fireEvent.change(paramInput, { target: { value: "example.com" } });

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await vi.waitFor(() =>
      expect(clientMock.testCustomAction).toHaveBeenCalledTimes(1),
    );
    expect(clientMock.testCustomAction.mock.calls[0]).toEqual([
      "act-test-1",
      { host: "example.com" },
    ]);
    // The JSON result is rendered back into the panel.
    await screen.findByText(/"output": "pong"/);
  });
});
