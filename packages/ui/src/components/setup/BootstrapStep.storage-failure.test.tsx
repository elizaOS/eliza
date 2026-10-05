/**
 * Verifies the bootstrap recovery screen fails visibly when the exchanged
 * session cannot be persisted: the error is shown, startup does not advance,
 * and the session is never published to the live client (#29918).
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({ persist: vi.fn() }));
const liveClient = vi.hoisted(() => ({ setToken: vi.fn() }));

vi.mock("../../state/active-server-credential", () => ({
  persistActiveServerCredential: persistence.persist,
}));

vi.mock("../../api/client", () => ({
  client: {
    setToken: liveClient.setToken,
    postBootstrapExchange: vi.fn(),
  },
}));

import { BootstrapStep } from "./BootstrapStep";

describe("BootstrapStep credential persistence", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it("shows a storage error instead of hanging when the session cannot be saved", async () => {
    persistence.persist.mockRejectedValue(new Error("Keychain denied"));
    const onAdvance = vi.fn();
    const exchangeFn = vi.fn(async () => ({
      ok: true as const,
      sessionId: "session-1",
      expiresAt: Date.now() + 60_000,
      identityId: "identity-1",
    }));
    render(<BootstrapStep onAdvance={onAdvance} exchangeFn={exchangeFn} />);

    fireEvent.change(
      screen.getByPlaceholderText("Paste your bootstrap token here"),
      { target: { value: "bootstrap-token" } },
    );
    fireEvent.submit(
      screen.getByRole("form", { name: "Bootstrap token entry" }),
    );

    expect(
      await screen.findByText(/The session could not be saved/),
    ).toBeTruthy();
    expect(onAdvance).not.toHaveBeenCalled();
    expect(liveClient.setToken).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("eliza_session")).toBeNull();
  });
});
