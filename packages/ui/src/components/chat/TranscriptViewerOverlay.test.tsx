// @vitest-environment jsdom
//
// The maximized, editable transcript viewer: it loads the stored record, lets
// the user edit + undo, copies/shares/saves-to-files, and persists on save.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageAttachment } from "../../api/client-types-chat";
import { RoleProvider } from "../../hooks/useRole";

const {
  getTranscript,
  updateTranscript,
  deleteTranscript,
  shareTranscript,
  revokeTranscriptShare,
} = vi.hoisted(() => ({
  getTranscript: vi.fn(),
  updateTranscript: vi.fn(),
  deleteTranscript: vi.fn(),
  shareTranscript: vi.fn(),
  revokeTranscriptShare: vi.fn(),
}));
vi.mock("../../api", () => ({
  client: {
    getTranscript,
    updateTranscript,
    deleteTranscript,
    shareTranscript,
    revokeTranscriptShare,
  },
}));
const { navigateBrowserPath } = vi.hoisted(() => ({
  navigateBrowserPath: vi.fn(),
}));
vi.mock("../../app-navigate-view", () => ({ navigateBrowserPath }));

import {
  segmentsFromEditedText,
  TranscriptViewerOverlay,
  type TranscriptViewerOverlayProps,
  withTranscriptMarker,
} from "./TranscriptViewerOverlay";

const SEG = (text: string, speakerLabel?: string) => ({
  id: "s1",
  text,
  speakerLabel,
  startMs: 0,
  endMs: 2000,
  words: [{ text: "x", startMs: 0, endMs: 2000 }],
});

function transcriptAttachment(): MessageAttachment {
  return {
    id: "att-1",
    url: "data:text/markdown;base64,aGVsbG8=",
    contentType: "document",
    mimeType: "text/markdown",
    title: "Transcript 2026-06-21 09:00.md",
    text: "hello world",
    transcriptId: "00000000-0000-0000-0000-000000000abc",
  };
}

function renderOverlay(
  role: "GUEST" | "USER" | "ADMIN" | "OWNER",
  props: Partial<TranscriptViewerOverlayProps> = {},
) {
  return render(
    <RoleProvider role={role}>
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={() => {}}
        {...props}
      />
    </RoleProvider>,
  );
}

describe("segmentsFromEditedText", () => {
  it("preserves per-segment timing + words when the line count is unchanged", () => {
    const original = [SEG("hello world", "Alice"), SEG("bye now", "Bob")];
    const out = segmentsFromEditedText(
      "Alice: hello there\nBob: bye now",
      original,
    );
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("hello there");
    expect(out[0].speakerLabel).toBe("Alice");
    expect(out[0].startMs).toBe(0); // original timing preserved
    expect(out[1].text).toBe("bye now");
  });

  it("rebuilds one segment per line when the structure changed", () => {
    const original = [SEG("one two three", "Alice")];
    const out = segmentsFromEditedText("one\ntwo\nthree", original);
    expect(out.map((s) => s.text)).toEqual(["one", "two", "three"]);
    expect(out.every((s) => s.id && s.words.length === 0)).toBe(true);
  });
});

describe("withTranscriptMarker", () => {
  it("embeds a durable, round-trippable id marker", () => {
    const marked = withTranscriptMarker("abc-123", "the text");
    expect(marked).toBe("<!-- eliza:transcript:abc-123 -->\nthe text");
  });
});

describe("TranscriptViewerOverlay", () => {
  beforeEach(() => {
    getTranscript.mockReset();
    updateTranscript.mockReset();
    deleteTranscript.mockReset();
    shareTranscript.mockReset();
    revokeTranscriptShare.mockReset();
    navigateBrowserPath.mockReset();
    getTranscript.mockResolvedValue({
      transcript: {
        id: "00000000-0000-0000-0000-000000000abc",
        title: "My Recording",
        segments: [SEG("hello world")],
        audioUrl: "/api/media/abc123.wav",
        scope: "owner-private",
      },
    });
    updateTranscript.mockResolvedValue({ transcript: {} });
    deleteTranscript.mockResolvedValue({ ok: true });
    shareTranscript.mockResolvedValue({
      ok: true,
      transcriptId: "00000000-0000-0000-0000-000000000abc",
      entityId: "99999999-9999-9999-9999-999999999999",
      mode: "redacted",
    });
    revokeTranscriptShare.mockResolvedValue({
      ok: true,
      transcriptId: "00000000-0000-0000-0000-000000000abc",
      entityId: "99999999-9999-9999-9999-999999999999",
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(cleanup);

  it("loads the stored record and shows its text + title", async () => {
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("transcript-text").textContent).toContain(
        "hello world",
      ),
    );
    expect(screen.getByText("My Recording")).toBeTruthy();
  });

  it("edits, undoes back to the loaded text, and persists on save & exit", async () => {
    const onClose = vi.fn();
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));

    fireEvent.click(screen.getByTestId("transcript-edit"));
    const editor = screen.getByTestId(
      "transcript-editor",
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "hello edited" } });
    expect(editor.value).toBe("hello edited");

    // Undo restores the loaded text.
    fireEvent.click(screen.getByTestId("transcript-undo"));
    expect(
      (screen.getByTestId("transcript-editor") as HTMLTextAreaElement).value,
    ).toBe("hello world");

    // Re-edit, then save & exit → persists via updateTranscript + closes.
    fireEvent.change(screen.getByTestId("transcript-editor"), {
      target: { value: "hello fixed" },
    });
    fireEvent.click(screen.getByTestId("transcript-save-exit"));
    await waitFor(() => expect(updateTranscript).toHaveBeenCalledTimes(1));
    expect(updateTranscript).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000abc",
      { segments: [expect.objectContaining({ text: "hello fixed" })] },
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("copies the text to the clipboard and reports 'Copied' on success", async () => {
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-copy"));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello world"),
    );
    // "Copied" is shown only because the write actually resolved.
    await waitFor(() =>
      expect(screen.getByTestId("transcript-copy").textContent).toContain(
        "Copied",
      ),
    );
  });

  it("does NOT report 'Copied' when the clipboard write rejects — surfaces the failure", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-copy"));
    // The failure is surfaced on the control, and it never claims success.
    await waitFor(() =>
      expect(screen.getByTestId("transcript-copy").textContent).toMatch(
        /failed/i,
      ),
    );
    expect(screen.getByTestId("transcript-copy").textContent).not.toContain(
      "Copied",
    );
  });

  it("opens the permission sheet and grants redacted transcript access", async () => {
    renderOverlay("USER");
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    expect(screen.getByTestId("transcript-share-sheet")).toBeTruthy();
    fireEvent.change(screen.getByTestId("transcript-share-entity"), {
      target: { value: "99999999-9999-9999-9999-999999999999" },
    });
    fireEvent.click(screen.getByTestId("transcript-grant-share"));
    await waitFor(() =>
      expect(shareTranscript).toHaveBeenCalledWith(
        "00000000-0000-0000-0000-000000000abc",
        {
          entityId: "99999999-9999-9999-9999-999999999999",
          mode: "redacted",
        },
      ),
    );
    expect(screen.getByTestId("transcript-share-success").textContent).toMatch(
      /redacted/i,
    );
  });

  it("revokes transcript access for the entered recipient", async () => {
    renderOverlay("USER");
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    fireEvent.change(screen.getByTestId("transcript-share-entity"), {
      target: { value: "99999999-9999-9999-9999-999999999999" },
    });
    fireEvent.click(screen.getByTestId("transcript-revoke-share"));
    await waitFor(() =>
      expect(revokeTranscriptShare).toHaveBeenCalledWith(
        "00000000-0000-0000-0000-000000000abc",
        "99999999-9999-9999-9999-999999999999",
      ),
    );
    expect(screen.getByTestId("transcript-share-success").textContent).toMatch(
      /revoked/i,
    );
  });

  it("keeps full transcript sharing behind the admin role gate", async () => {
    renderOverlay("USER");
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    expect(screen.queryByTestId("transcript-share-mode-full")).toBeNull();
    cleanup();

    renderOverlay("ADMIN");
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    fireEvent.click(screen.getByTestId("transcript-share-mode-full"));
    fireEvent.change(screen.getByTestId("transcript-share-entity"), {
      target: { value: "99999999-9999-9999-9999-999999999999" },
    });
    fireEvent.click(screen.getByTestId("transcript-grant-share"));
    await waitFor(() =>
      expect(shareTranscript).toHaveBeenCalledWith(
        "00000000-0000-0000-0000-000000000abc",
        {
          entityId: "99999999-9999-9999-9999-999999999999",
          mode: "full",
        },
      ),
    );
    cleanup();

    renderOverlay("OWNER");
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    expect(screen.getByTestId("transcript-share-mode-full")).toBeTruthy();
  });

  it("renders redacted transcript views as read-only and unshareable", async () => {
    getTranscript.mockResolvedValueOnce({
      transcript: {
        id: "00000000-0000-0000-0000-000000000abc",
        title: "Redacted Recording",
        segments: [SEG("[EMAIL]")],
        scope: "owner-private",
        redacted: true,
      },
    });
    renderOverlay("USER");
    await waitFor(() => screen.getByTestId("transcript-text"));

    expect(screen.getByTestId("transcript-privacy-badge").textContent).toMatch(
      /redacted/i,
    );
    expect(screen.queryByTestId("transcript-edit")).toBeNull();
    expect(screen.queryByTestId("transcript-delete")).toBeNull();
    expect(
      (screen.getByTestId("transcript-share") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("cancel closes without persisting", async () => {
    const onClose = vi.fn();
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(updateTranscript).not.toHaveBeenCalled();
  });

  it("resolves the record id from the durable marker when the field is gone", async () => {
    // Simulate the post-turn reload: no transcriptId field, marker in text.
    const att: MessageAttachment = {
      ...transcriptAttachment(),
      transcriptId: undefined,
      text: withTranscriptMarker(
        "00000000-0000-0000-0000-000000000abc",
        "hello world",
      ),
    };
    render(<TranscriptViewerOverlay attachment={att} onClose={() => {}} />);
    await waitFor(() =>
      expect(getTranscript).toHaveBeenCalledWith(
        "00000000-0000-0000-0000-000000000abc",
      ),
    );
    // Marker is stripped from the displayed text.
    expect(screen.getByTestId("transcript-text").textContent).not.toContain(
      "eliza:transcript",
    );
  });

  it("plays the recorded audio and offers save/share-audio when the record has audio", async () => {
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-audio"));
    const audio = screen.getByTestId("transcript-audio") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toContain("/api/media/abc123.wav");
    expect(screen.getByTestId("transcript-save-audio")).toBeTruthy();
    expect(screen.getByTestId("transcript-share-audio")).toBeTruthy();
  });

  it("hides the audio controls when the transcript has no audio", async () => {
    getTranscript.mockResolvedValueOnce({
      transcript: {
        id: "00000000-0000-0000-0000-000000000abc",
        title: "No Audio",
        segments: [SEG("hello world")],
        audioUrl: null,
      },
    });
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));
    expect(screen.queryByTestId("transcript-audio")).toBeNull();
    expect(screen.queryByTestId("transcript-save-audio")).toBeNull();
  });

  it("deletes the transcript on a confirmed two-tap, then closes", async () => {
    const onClose = vi.fn();
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-delete"));
    // First tap arms the confirm; does not delete.
    fireEvent.click(screen.getByTestId("transcript-delete"));
    expect(deleteTranscript).not.toHaveBeenCalled();
    expect(screen.getByTestId("transcript-delete").textContent).toMatch(
      /confirm/i,
    );
    // Second tap deletes + closes.
    fireEvent.click(screen.getByTestId("transcript-delete"));
    await waitFor(() =>
      expect(deleteTranscript).toHaveBeenCalledWith(
        "00000000-0000-0000-0000-000000000abc",
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("opens the Transcripts view to listen, and closes", async () => {
    const onClose = vi.fn();
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-open-in-transcripts"));
    fireEvent.click(screen.getByTestId("transcript-open-in-transcripts"));
    expect(navigateBrowserPath).toHaveBeenCalledWith("/apps/transcripts");
    expect(onClose).toHaveBeenCalled();
  });

  it("renders a load error — never '(empty transcript)' — when the inline read fails with no stored record", async () => {
    // Served-URL attachment with no inline text and no transcriptId: the
    // fetch rejecting must surface as the designed error state (three-state
    // rule), not as a healthy-empty transcript.
    const failingFetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", failingFetch);
    try {
      render(
        <TranscriptViewerOverlay
          attachment={{
            id: "att-2",
            url: "/api/media/deadbeef.md",
            contentType: "document",
            mimeType: "text/markdown",
            title: "Broken transcript.md",
          }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => screen.getByTestId("transcript-load-error"));
      expect(failingFetch).toHaveBeenCalled();
      expect(screen.queryByTestId("transcript-text")).toBeNull();
      expect(getTranscript).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
