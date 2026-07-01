// @vitest-environment jsdom
//
// SECURITY behavioral coverage for the vault / secrets manager inventory panel
// (packages/ui/src/components/settings/VaultInventoryPanel.tsx). The unit under
// test is the real VaultInventoryPanel + AddSecretForm + EntryRow state
// machines; the ONLY mocked collaborators are:
//   - global `fetch` (the vault HTTP API boundary)
//   - `window.confirm` (the browser delete-confirmation gate)
//   - `../../agent-surface` useAgentElement (view instrumentation, not the unit)
//   - `../../state/TranslationContext.hooks` useTranslation (i18n; STABLE `t`)
//
// What it locks down:
//   - Adding a secret persists via PUT /api/secrets/inventory/<key> with the
//     value + category in the body, and fires the parent onChanged.
//   - The secret VALUE is never rendered in plaintext: the input is a masked
//     password field while typing, and after save the value is nowhere in DOM.
//   - Deleting a secret is gated behind window.confirm — declining fires NO
//     network call; accepting fires exactly one DELETE and onChanged.
//   - In-flight submit is idempotent (double-click cannot double-POST).
//   - Adversarial/whitespace-only input cannot submit.
//   - A failed save surfaces an error banner and does NOT close/confirm success.
//   - A stored value is masked-by-default and only appears after an explicit
//     reveal (GET /api/secrets/inventory/<key>).

import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultEntryMeta } from "./vault-tabs/types";

// Stable agent-surface stub: useAgentElement is called ~a dozen times per
// render; returning fresh refs/props is fine, but the stub must never throw.
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

// STABLE translation singleton. A fresh `{ t }` per render would change the
// identity captured by useCallback deps and spin the effect loop → hang.
const i18nMock = vi.hoisted(() => {
  const t = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return { t, uiLanguage: "en", setUiLanguage: () => {} };
});
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => i18nMock,
}));

import { VaultInventoryPanel } from "./VaultInventoryPanel";

// ── fetch harness ──────────────────────────────────────────────────

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

const calls: FetchCall[] = [];
let respond: (url: string, init?: RequestInit) => Promise<Response> | Response;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  respond = () => jsonResponse({ entries: [] });
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    return Promise.resolve(respond(url, init));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeEntry(over: Partial<VaultEntryMeta> = {}): VaultEntryMeta {
  return {
    key: "OPENAI_API_KEY",
    category: "provider",
    label: "OpenAI",
    hasProfiles: false,
    kind: "secret",
    ...over,
  };
}

const SECRET = "sk-live-SUPER-SECRET-value-9000";

function mutationCalls(): FetchCall[] {
  // Ignore the panel's own GET /api/secrets/inventory refresh reads.
  return calls.filter((c) => c.method !== "GET");
}

// ── add ────────────────────────────────────────────────────────────

describe("VaultInventoryPanel — add secret", () => {
  it("persists via PUT with value+category, masks the value, and never renders it in plaintext", async () => {
    const onChanged = vi.fn();
    respond = () => jsonResponse({}); // PUT ok
    const user = userEvent.setup();
    const { container, getByPlaceholderText } = render(
      <VaultInventoryPanel entries={[]} onChanged={onChanged} />,
    );

    await user.click(container.querySelector<HTMLButtonElement>('[aria-label="Add secret"]')!);

    const keyInput = getByPlaceholderText("OPENROUTER_API_KEY") as HTMLInputElement;
    // The value field is the only masked (password) input in the form.
    const valueInput = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    expect(valueInput).toBeTruthy();
    expect(valueInput.type).toBe("password"); // masked while typing

    await user.type(keyInput, "OPENAI_API_KEY");
    await user.type(valueInput, SECRET);

    const form = container.querySelector<HTMLFormElement>(
      '[data-testid="vault-add-secret-form"]',
    )!;
    const saveBtn = within(form).getByRole("button", { name: "Save secret" });
    await user.click(saveBtn);

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    const put = mutationCalls().find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.url).toBe("/api/secrets/inventory/OPENAI_API_KEY");
    // Default category is "plugin" until the user picks another in the select.
    expect(put!.body).toMatchObject({ value: SECRET, category: "plugin" });

    // Form closed on save → the secret value is nowhere in the DOM.
    expect(
      container.querySelector('[data-testid="vault-add-secret-form"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain(SECRET);
    const anyInputHasSecret = Array.from(
      container.querySelectorAll("input"),
    ).some((el) => (el as HTMLInputElement).value === SECRET);
    expect(anyInputHasSecret).toBe(false);
  });

  it("cannot submit whitespace-only key (adversarial) — save stays disabled, no PUT", async () => {
    const onChanged = vi.fn();
    const user = userEvent.setup();
    const { container, getByPlaceholderText } = render(
      <VaultInventoryPanel entries={[]} onChanged={onChanged} />,
    );
    await user.click(container.querySelector<HTMLButtonElement>('[aria-label="Add secret"]')!);

    await user.type(getByPlaceholderText("OPENROUTER_API_KEY"), "   ");
    await user.type(container.querySelector<HTMLInputElement>('input[type="password"]')!, SECRET);

    const form = container.querySelector<HTMLFormElement>(
      '[data-testid="vault-add-secret-form"]',
    )!;
    const saveBtn = within(form).getByRole("button", {
      name: "Save secret",
    }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Even forcing a submit does nothing — onSubmit early-returns.
    form.requestSubmit?.();
    await Promise.resolve();
    expect(mutationCalls()).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("is idempotent under a double-click while the save is in flight", async () => {
    const onChanged = vi.fn();
    let release!: () => void;
    respond = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse({}));
      });
    const user = userEvent.setup();
    const { container, getByPlaceholderText } = render(
      <VaultInventoryPanel entries={[]} onChanged={onChanged} />,
    );
    await user.click(container.querySelector<HTMLButtonElement>('[aria-label="Add secret"]')!);
    await user.type(getByPlaceholderText("OPENROUTER_API_KEY"), "OPENAI_API_KEY");
    await user.type(container.querySelector<HTMLInputElement>('input[type="password"]')!, SECRET);

    const form = container.querySelector<HTMLFormElement>(
      '[data-testid="vault-add-secret-form"]',
    )!;
    const saveBtn = within(form).getByRole("button", {
      name: "Save secret",
    }) as HTMLButtonElement;

    await user.click(saveBtn);
    // In-flight: button is disabled, so a second click is a no-op.
    expect(saveBtn.disabled).toBe(true);
    await user.click(saveBtn).catch(() => {});

    release();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mutationCalls().filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("surfaces a save error and keeps the form open (no false success)", async () => {
    const onChanged = vi.fn();
    respond = () => jsonResponse({}, false, 500);
    const user = userEvent.setup();
    const { container, getByPlaceholderText } = render(
      <VaultInventoryPanel entries={[]} onChanged={onChanged} />,
    );
    await user.click(container.querySelector<HTMLButtonElement>('[aria-label="Add secret"]')!);
    await user.type(getByPlaceholderText("OPENROUTER_API_KEY"), "OPENAI_API_KEY");
    await user.type(container.querySelector<HTMLInputElement>('input[type="password"]')!, SECRET);

    const form = container.querySelector<HTMLFormElement>(
      '[data-testid="vault-add-secret-form"]',
    )!;
    await user.click(within(form).getByRole("button", { name: "Save secret" }));

    await waitFor(() => expect(container.textContent).toContain("HTTP 500"));
    expect(onChanged).not.toHaveBeenCalled();
    // Form still mounted — the user can retry, not silently "saved".
    expect(
      container.querySelector('[data-testid="vault-add-secret-form"]'),
    ).not.toBeNull();
  });
});

// ── delete ─────────────────────────────────────────────────────────

describe("VaultInventoryPanel — delete secret", () => {
  it("does nothing when the confirm gate is declined", async () => {
    const onChanged = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    const { container } = render(
      <VaultInventoryPanel entries={[makeEntry()]} onChanged={onChanged} />,
    );

    await user.click(
      container.querySelector<HTMLButtonElement>('[aria-label="Delete OpenAI"]')!,
    );

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mutationCalls()).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("fires exactly one DELETE + onChanged when confirmed", async () => {
    const onChanged = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    respond = () => jsonResponse({});
    const user = userEvent.setup();
    const { container } = render(
      <VaultInventoryPanel entries={[makeEntry()]} onChanged={onChanged} />,
    );

    await user.click(
      container.querySelector<HTMLButtonElement>('[aria-label="Delete OpenAI"]')!,
    );

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const del = mutationCalls().filter((c) => c.method === "DELETE");
    expect(del).toHaveLength(1);
    expect(del[0].url).toBe("/api/secrets/inventory/OPENAI_API_KEY");
  });
});

// ── masking / reveal ───────────────────────────────────────────────

describe("VaultInventoryPanel — value masking", () => {
  it("never shows a stored value until an explicit reveal fetch", async () => {
    const user = userEvent.setup();
    respond = (_url) =>
      jsonResponse({ value: SECRET, source: "direct" });
    const { container } = render(
      <VaultInventoryPanel entries={[makeEntry()]} onChanged={() => {}} />,
    );

    // Masked by default: only key + label are shown, never the value.
    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).toContain("OPENAI_API_KEY");
    expect(container.textContent).not.toContain(SECRET);

    await user.click(
      container.querySelector<HTMLButtonElement>('[aria-label="Reveal OpenAI"]')!,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="vault-revealed-OPENAI_API_KEY"]'),
      ).not.toBeNull(),
    );
    const revealed = container.querySelector(
      '[data-testid="vault-revealed-OPENAI_API_KEY"]',
    )!;
    expect(revealed.textContent).toContain(SECRET);
    // The reveal is an authenticated GET for this exact key.
    expect(
      calls.some(
        (c) =>
          c.method === "GET" &&
          c.url === "/api/secrets/inventory/OPENAI_API_KEY",
      ),
    ).toBe(true);
  });
});
