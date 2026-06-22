// @vitest-environment jsdom
//
// Render test for the shared chat MessageAttachments renderer: each media kind
// produces the right element (image / audio / video / file card), and clicking
// an image opens the full-screen lightbox.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageAttachment } from "../../api/client-types-chat";
import {
  attachmentPreviewKind,
  MessageAttachments,
  resolveAttachmentUrl,
} from "./MessageAttachments";

afterEach(cleanup);

describe("resolveAttachmentUrl", () => {
  it("passes absolute and data URLs through untouched", () => {
    expect(resolveAttachmentUrl("https://x/y.png")).toBe("https://x/y.png");
    expect(resolveAttachmentUrl("data:image/png;base64,AA")).toBe(
      "data:image/png;base64,AA",
    );
    expect(resolveAttachmentUrl("blob:abc")).toBe("blob:abc");
  });
});

describe("MessageAttachments", () => {
  it("renders nothing for an empty list", () => {
    const { container } = render(
      <MessageAttachments attachments={undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders an image, audio, video, and file card by kind", () => {
    const attachments: MessageAttachment[] = [
      {
        id: "img",
        url: "https://x/cat.png",
        contentType: "image",
        title: "cat",
      },
      {
        id: "aud",
        url: "https://x/clip.mp3",
        contentType: "audio",
        title: "clip",
      },
      { id: "vid", url: "https://x/clip.mp4", contentType: "video" },
      {
        // A non-previewable document (binary, no extracted text) keeps the
        // generic download card. PDFs and text/code now get inline previews —
        // covered by the "PDF + text/code previews" suite below.
        id: "doc",
        url: "https://x/archive.zip",
        contentType: "document",
        title: "archive.zip",
      },
    ];
    const { container } = render(
      <MessageAttachments attachments={attachments} />,
    );
    // Image
    const img = container.querySelector('img[src="https://x/cat.png"]');
    expect(img).not.toBeNull();
    // Audio + video players
    expect(container.querySelector("audio")).not.toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
    // File card links to the document with a download affordance
    const docLink = screen.getByRole("link", { name: /archive\.zip/i });
    expect(docLink.getAttribute("href")).toBe("https://x/archive.zip");
  });

  it("infers kind from extension when contentType is absent", () => {
    const { container } = render(
      <MessageAttachments
        attachments={[{ id: "x", url: "https://cdn/x/sound.wav" }]}
      />,
    );
    expect(container.querySelector("audio")).not.toBeNull();
  });

  it("opens a lightbox when an image is clicked", () => {
    render(
      <MessageAttachments
        attachments={[
          {
            id: "img",
            url: "https://x/cat.png",
            contentType: "image",
            title: "cat",
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
    // The tile exposes two expand affordances (thumbnail + hover control);
    // either opens the lightbox.
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand image/i })[0],
    );
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeNull();
  });
});

describe("attachmentPreviewKind", () => {
  const make = (over: Partial<MessageAttachment>): MessageAttachment => ({
    id: "x",
    url: "https://x/file",
    ...over,
  });

  it("maps PDFs from extension, mime, and data: URL", () => {
    expect(attachmentPreviewKind(make({ url: "https://x/report.pdf" }))).toBe(
      "pdf",
    );
    expect(
      attachmentPreviewKind(make({ url: "https://x/r.pdf?token=1#p=2" })),
    ).toBe("pdf");
    expect(
      attachmentPreviewKind(
        make({ url: "https://x/blob", mimeType: "application/pdf" }),
      ),
    ).toBe("pdf");
    expect(
      attachmentPreviewKind(make({ url: "data:application/pdf;base64,AA" })),
    ).toBe("pdf");
  });

  it("maps text/code from extension, mime, and att.text", () => {
    for (const ext of ["txt", "md", "json", "csv", "log", "ts", "js", "py"]) {
      expect(attachmentPreviewKind(make({ url: `https://x/a.${ext}` }))).toBe(
        "code",
      );
    }
    expect(
      attachmentPreviewKind(
        make({ url: "https://x/notes", mimeType: "text/plain" }),
      ),
    ).toBe("code");
    expect(
      attachmentPreviewKind(make({ url: "https://x/blob", text: "hello" })),
    ).toBe("code");
  });

  it("falls back to file for unknown / binary documents", () => {
    expect(attachmentPreviewKind(make({ url: "https://x/archive.zip" }))).toBe(
      "file",
    );
    expect(attachmentPreviewKind(make({ url: "https://x/sheet.docx" }))).toBe(
      "file",
    );
    // Empty/whitespace text does not promote to a code preview.
    expect(
      attachmentPreviewKind(make({ url: "https://x/blob", text: "   " })),
    ).toBe("file");
  });
});

describe("MessageAttachments — PDF + text/code previews", () => {
  it("renders an inline sandboxed iframe for a served PDF", () => {
    const { container } = render(
      <MessageAttachments
        attachments={[
          {
            id: "pdf",
            url: "/api/media/abc.pdf",
            contentType: "document",
            title: "report.pdf",
          },
        ]}
      />,
    );
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame?.getAttribute("title")).toMatch(/report\.pdf/i);
    expect(screen.getByTestId("pdf-attachment")).not.toBeNull();
  });

  it("renders a download card (no iframe) for a data: PDF", () => {
    const { container } = render(
      <MessageAttachments
        attachments={[
          {
            id: "pdf-data",
            url: "data:application/pdf;base64,JVBERi0=",
            contentType: "document",
            title: "inline.pdf",
          },
        ]}
      />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    const card = screen.getByTestId("pdf-attachment-fallback");
    expect(card.getAttribute("href")).toBe(
      "data:application/pdf;base64,JVBERi0=",
    );
  });

  it("renders inline CodeBlock content when att.text is present", () => {
    render(
      <MessageAttachments
        attachments={[
          {
            id: "code",
            url: "https://x/snippet.ts",
            contentType: "document",
            title: "snippet.ts",
            text: "export const answer = 42;",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("code-attachment")).not.toBeNull();
    expect(screen.getByText(/export const answer = 42;/)).not.toBeNull();
  });

  it("renders a download card for a text attachment without att.text", () => {
    render(
      <MessageAttachments
        attachments={[
          {
            id: "code-nofetch",
            url: "https://x/big.log",
            contentType: "document",
            title: "big.log",
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("code-attachment")).toBeNull();
    expect(screen.getByTestId("code-attachment-fallback")).not.toBeNull();
  });
});
