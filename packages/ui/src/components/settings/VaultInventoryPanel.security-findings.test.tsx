/**
 * Owner-facing connector fallback coverage. The panel must identify protected
 * credential locations without ever receiving or rendering credential values.
 * @vitest-environment jsdom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultInventoryPanel } from "./VaultInventoryPanel";

const clientMocks = vi.hoisted(() => ({
  rawRequest: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  client: clientMocks,
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

beforeEach(() => {
  clientMocks.rawRequest.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VaultInventoryPanel connector security findings", () => {
  it("shows non-revealing credential locations outside encrypted Vault storage", () => {
    render(
      <VaultInventoryPanel
        entries={[]}
        securityFindings={[
          {
            id: "state:telegram-account:session",
            connector: "telegram-account",
            label: "Telegram Personal session",
            source: "state-file",
            protection: "mode-0600",
            autoMigratesOnDesktop: false,
            detail:
              "Protected by local file permissions, but not encrypted by Vault.",
          },
        ]}
      />,
    );

    expect(screen.getByTestId("vault-security-findings")).toBeTruthy();
    expect(screen.getByText("Telegram Personal session")).toBeTruthy();
    expect(screen.getByText(/outside encrypted Vault storage/)).toBeTruthy();
    expect(screen.queryByText(/session-secret/)).toBeNull();
  });

  it("reveals only on demand and hides on focus loss without exposing values in errors", async () => {
    clientMocks.rawRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        value: "opaque-test-value",
        source: "vault",
      }),
    });
    render(
      <VaultInventoryPanel
        entries={[
          {
            key: "TEST_API_KEY",
            category: "provider",
            label: "Test provider",
            hasProfiles: false,
            kind: "secret",
          },
        ]}
      />,
    );

    expect(screen.queryByText("opaque-test-value")).toBeNull();
    fireEvent.click(screen.getByLabelText("Reveal Test provider"));
    expect(await screen.findByText("opaque-test-value")).toBeTruthy();
    expect(
      screen.getByLabelText("Temporarily revealed value for Test provider"),
    ).toBeTruthy();

    fireEvent(window, new Event("blur"));
    await waitFor(() => {
      expect(screen.queryByText("opaque-test-value")).toBeNull();
    });

    clientMocks.rawRequest.mockResolvedValueOnce({ ok: false, status: 423 });
    fireEvent.click(screen.getByLabelText("Reveal Test provider"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/unlock the system credential store/i);
    expect(alert.textContent).not.toContain("opaque-test-value");
  });

  it("retains the row and reports a truthful recovery check when secure deletion is rejected", async () => {
    clientMocks.rawRequest.mockResolvedValueOnce({ ok: false, status: 503 });
    const onChanged = vi.fn();
    render(
      <VaultInventoryPanel
        entries={[
          {
            key: "TEST_API_KEY",
            category: "provider",
            label: "Test provider",
            hasProfiles: false,
            kind: "secret",
          },
        ]}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByLabelText("Delete Test provider"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(clientMocks.rawRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Permanently delete Test provider"));
    expect(
      await screen.findByText(/refresh the Vault to confirm/i),
    ).toBeTruthy();
    expect(screen.getByTestId("vault-entry-row-TEST_API_KEY")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    expect(clientMocks.rawRequest).toHaveBeenCalledWith(
      "/api/secrets/inventory/TEST_API_KEY",
      { method: "DELETE" },
      { allowNonOk: true, timeoutMs: 30_000 },
    );
  });

  it("keeps deletion in-app and lets the owner cancel without a request", () => {
    render(
      <VaultInventoryPanel
        entries={[
          {
            key: "TEST_API_KEY",
            category: "provider",
            label: "Test provider",
            hasProfiles: false,
            kind: "secret",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Delete Test provider"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Cancel deleting Test provider"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(clientMocks.rawRequest).not.toHaveBeenCalled();
  });

  it("gives a first native secure write the extended Keychain budget", async () => {
    clientMocks.rawRequest.mockResolvedValueOnce({ ok: true, status: 200 });
    const onChanged = vi.fn();
    const { container } = render(
      <VaultInventoryPanel entries={[]} onChanged={onChanged} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    fireEvent.change(screen.getByPlaceholderText("OPENROUTER_API_KEY"), {
      target: { value: "SYNTHETIC_QA_KEY" },
    });
    fireEvent.change(screen.getByPlaceholderText("OpenRouter"), {
      target: { value: "Synthetic QA" },
    });
    const password = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(password).toBeTruthy();
    fireEvent.change(password as HTMLInputElement, {
      target: { value: "disposable-test-only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(clientMocks.rawRequest).toHaveBeenCalledWith(
      "/api/secrets/inventory/SYNTHETIC_QA_KEY",
      expect.objectContaining({ method: "PUT" }),
      { allowNonOk: true, timeoutMs: 30_000 },
    );
  });
});

// A scan that failed is not a scan that found nothing. Rendering the empty
// list would tell an owner their connector credentials are clean when the
// server never established that - the worst default for a security surface.
describe("unavailable connector scan", () => {
  it("says the scan did not run instead of showing a clean result", () => {
    render(
      <VaultInventoryPanel
        entries={[]}
        securityFindings={[]}
        securityFindingsAvailable={false}
      />,
    );

    expect(
      screen.getByTestId("vault-security-findings-unavailable"),
    ).toBeTruthy();
    expect(screen.queryByTestId("vault-security-findings")).toBeNull();
  });

  it("renders findings normally when the scan did run", () => {
    render(
      <VaultInventoryPanel
        entries={[]}
        securityFindings={[
          {
            id: "state:telegram-account:session",
            connector: "telegram-account",
            label: "Telegram Personal session",
            source: "state-file",
            protection: "mode-0600",
            autoMigratesOnDesktop: false,
            detail: "Protected by local file permissions, not encrypted.",
          },
        ]}
        securityFindingsAvailable={true}
      />,
    );

    expect(screen.getByTestId("vault-security-findings")).toBeTruthy();
    expect(
      screen.queryByTestId("vault-security-findings-unavailable"),
    ).toBeNull();
  });
});
