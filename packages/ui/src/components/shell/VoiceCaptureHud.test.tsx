/** Verifies VoiceCaptureHud through the package's configured test harness. */
// @vitest-environment jsdom
//
// VoiceCaptureHud — on-screen voice-capture trace for the installed PWA (no
// devtools). Stamped-builds-only (same /build-info.json gate as BuildBadge);
// renders the breadcrumb ring bottom-anchored above the composer; dismissible
// for the session.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetVoiceCaptureBreadcrumbs,
  voiceCaptureDebug,
} from "../../utils/voice-capture-debug";
import { VoiceCaptureHud } from "./VoiceCaptureHud";

const BUILD_INFO = {
  commit: "62d49c0c7d",
  builtAt: "2026-07-07 18:00 MDT",
  label: "62d49c0c7d · Jul 07 18:00 MDT",
};

function mockFetchOk(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

function mockFetchMissing() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch,
  );
}

describe("VoiceCaptureHud", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetVoiceCaptureBreadcrumbs();
  });

  afterEach(() => {
    cleanup();
    resetVoiceCaptureBreadcrumbs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the breadcrumb trace on a stamped build", async () => {
    mockFetchOk(BUILD_INFO);
    voiceCaptureDebug("mic:tap", { surface: "composer" });
    voiceCaptureDebug("gum:req");
    voiceCaptureDebug("gum:ok", { ms: 120 });
    voiceCaptureDebug("provider:cloud");

    render(<VoiceCaptureHud />);

    const hud = await screen.findByTestId("voice-capture-hud");
    expect(hud).toBeTruthy();
    const lines = screen.getAllByTestId("voice-capture-hud-line");
    // All four steps of this tap are on screen.
    const text = lines.map((l) => l.textContent).join("|");
    expect(text).toContain("mic:tap");
    expect(text).toContain("gum:ok");
    expect(text).toContain("120ms");
    expect(text).toContain("provider:cloud");
  });

  it("marks a failing step (gum:err) so it reads as the death point", async () => {
    mockFetchOk(BUILD_INFO);
    voiceCaptureDebug("mic:tap");
    voiceCaptureDebug("gum:req");
    voiceCaptureDebug("gum:err", { name: "NotAllowedError" });

    render(<VoiceCaptureHud />);
    await screen.findByTestId("voice-capture-hud");
    const text = screen
      .getAllByTestId("voice-capture-hud-line")
      .map((l) => l.textContent)
      .join("|");
    expect(text).toContain("gum:err");
    expect(text).toContain("NotAllowedError");
  });

  it("renders NOTHING when the build stamp is absent (production)", async () => {
    mockFetchMissing();
    voiceCaptureDebug("mic:tap");
    render(<VoiceCaptureHud />);
    // Give the async gate a tick; it must stay hidden.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("voice-capture-hud")).toBeNull();
  });

  it("renders nothing when the ring is empty even on a stamped build", async () => {
    mockFetchOk(BUILD_INFO);
    render(<VoiceCaptureHud />);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/build-info.json",
        expect.objectContaining({ cache: "no-store" }),
      ),
    );
    expect(screen.queryByTestId("voice-capture-hud")).toBeNull();
  });

  it("hides for the session when dismissed", async () => {
    mockFetchOk(BUILD_INFO);
    voiceCaptureDebug("mic:tap");
    const { unmount } = render(<VoiceCaptureHud />);
    await screen.findByTestId("voice-capture-hud");

    await userEvent.click(screen.getByTestId("voice-capture-hud-dismiss"));
    expect(screen.queryByTestId("voice-capture-hud")).toBeNull();

    // Remount within the same session — stays hidden.
    unmount();
    voiceCaptureDebug("mic:tap");
    render(<VoiceCaptureHud />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("voice-capture-hud")).toBeNull();
  });
});
