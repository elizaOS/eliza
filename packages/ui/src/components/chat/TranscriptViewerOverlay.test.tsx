// @vitest-environment jsdom
//
// The maximized, editable transcript viewer: it loads the stored record, lets
// the user edit + undo, copies, grants/revokes access, and persists on save.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageAttachment } from "../../api/client-types-chat";

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

import { RoleProvider } from "../../hooks/useRole";
import {
  segmentsFromEditedText,
  TranscriptViewerOverlay,
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
    const userRole = { role: "USER" as const };
    render(
      <RoleProvider {...userRole}>
        <TranscriptViewerOverlay
          attachment={transcriptAttachment()}
          onClose={() => {}}
        />
      </RoleProvider>,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    expect(screen.getByTestId("transcript-share-sheet")).toBeTruthy();
    expect(
      screen.getByTestId("transcript-share-mode-full-disabled"),
    ).toBeTruthy();

    fireEvent.change(screen.getByTestId("transcript-share-target"), {
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

  it("surfaces route failures without claiming access changed", async () => {
    shareTranscript.mockRejectedValueOnce(new Error("denied"));
    const userRole = { role: "USER" as const };
    render(
      <RoleProvider {...userRole}>
        <TranscriptViewerOverlay
          attachment={transcriptAttachment()}
          onClose={() => {}}
        />
      </RoleProvider>,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    fireEvent.change(screen.getByTestId("transcript-share-target"), {
      target: { value: "99999999-9999-9999-9999-999999999999" },
    });
    fireEvent.click(screen.getByTestId("transcript-grant-share"));
    await waitFor(() =>
      expect(
        screen.getByTestId("transcript-share-error").textContent,
      ).toContain("denied"),
    );
    expect(screen.queryByTestId("transcript-share-success")).toBeNull();
  });

  it("lets admins grant full transcript access", async () => {
    shareTranscript.mockResolvedValueOnce({
      ok: true,
      transcriptId: "00000000-0000-0000-0000-000000000abc",
      entityId: "99999999-9999-9999-9999-999999999999",
      mode: "full",
    });
    const adminRole = { role: "ADMIN" as const };
    render(
      <RoleProvider {...adminRole}>
        <TranscriptViewerOverlay
          attachment={transcriptAttachment()}
          onClose={() => {}}
        />
      </RoleProvider>,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    fireEvent.click(screen.getByTestId("transcript-share-mode-full"));
    fireEvent.change(screen.getByTestId("transcript-share-target"), {
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
  });

  it("revokes transcript access for the entered recipient", async () => {
    const userRole = { role: "USER" as const };
    render(
      <RoleProvider {...userRole}>
        <TranscriptViewerOverlay
          attachment={transcriptAttachment()}
          onClose={() => {}}
        />
      </RoleProvider>,
    );
    await waitFor(() => screen.getByTestId("transcript-text"));
    fireEvent.click(screen.getByTestId("transcript-share"));
    fireEvent.change(screen.getByTestId("transcript-share-target"), {
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

  it("does not recover ids from inline marker text after marker retirement", async () => {
    const att: MessageAttachment = {
      ...transcriptAttachment(),
      transcriptId: undefined,
      text: "<!-- eliza:transcript:00000000-0000-0000-0000-000000000abc -->\nhello world",
    };
    render(<TranscriptViewerOverlay attachment={att} onClose={() => {}} />);
    await waitFor(() => screen.getByTestId("transcript-text"));
    expect(getTranscript).not.toHaveBeenCalled();
    expect(screen.getByTestId("transcript-text").textContent).toContain(
      "eliza:transcript",
    );
  });

  it("plays the recorded audio without duplicate audio share controls", async () => {
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-audio"));
    const audio = screen.getByTestId("transcript-audio") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toContain("/api/media/abc123.wav");
    expect(screen.queryByTestId("transcript-save-audio")).toBeNull();
    expect(screen.queryByTestId("transcript-share-audio")).toBeNull();
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

  it("opens the Knowledge view, and closes", async () => {
    const onClose = vi.fn();
    render(
      <TranscriptViewerOverlay
        attachment={transcriptAttachment()}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByTestId("transcript-open-in-knowledge"));
    fireEvent.click(screen.getByTestId("transcript-open-in-knowledge"));
    expect(navigateBrowserPath).toHaveBeenCalledWith("/character/documents");
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
