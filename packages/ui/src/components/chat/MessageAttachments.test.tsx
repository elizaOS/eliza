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
    // The audio card carries a stable testid (consistent with the pdf/model3d/
    // code/transcript/image tiles) so the generated-audio chat journey can
    // assert the player rendered. The <audio> element exposes its own testid.
    const audioCard = container.querySelector(
      '[data-testid="audio-attachment"]',
    );
    expect(audioCard).not.toBeNull();
    const audioEl = container.querySelector(
      '[data-testid="audio-attachment-player"]',
    );
    expect(audioEl).not.toBeNull();
    expect(audioEl?.getAttribute("src")).toBe("https://x/clip.mp3");
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

  it("maps 3D models from extension and mime (before text/code)", () => {
    expect(attachmentPreviewKind(make({ url: "https://x/scene.glb" }))).toBe(
      "model3d",
    );
    expect(
      attachmentPreviewKind(make({ url: "https://x/scene.gltf?v=2#a" })),
    ).toBe("model3d");
    expect(
      attachmentPreviewKind(
        make({ url: "https://x/blob", mimeType: "model/gltf-binary" }),
      ),
    ).toBe("model3d");
    // A .gltf is JSON text, but it must still preview as a model, not as code.
    expect(
      attachmentPreviewKind(
        make({ url: "https://x/scene.gltf", text: '{"asset":{}}' }),
      ),
    ).toBe("model3d");
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

  it("renders the 3D tile, degrading to a download fallback without WebGL (jsdom)", async () => {
    // jsdom has no WebGL context, so the model tile must surface its
    // download-to-view fallback rather than throwing — the bytes stay reachable.
    render(
      <MessageAttachments
        attachments={[
          {
            id: "model",
            url: "https://x/scene.glb",
            contentType: "document",
            title: "scene.glb",
          },
        ]}
      />,
    );
    // The tile chrome (with a download affordance) is always present.
    expect(screen.getByTestId("model3d-attachment")).not.toBeNull();
    // The WebGL probe runs in an effect; the fallback appears once it bails.
    const fallback = await screen.findByTestId("model3d-attachment-fallback");
    expect(fallback.getAttribute("href")).toBe("https://x/scene.glb");
    expect(fallback.getAttribute("download")).toMatch(/\.glb$/);
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

describe("MessageAttachments — unsafe-URL handling (security/error path)", () => {
  // An untrusted agent can put a dangerous-scheme URL on an attachment. The
  // renderer must NEVER hand such a URL to the browser as href/src — it degrades
  // to a non-clickable "unsupported attachment" card instead. This is the
  // scheme-allowlist guard (isSafeAttachmentUrl) at the render boundary.
  const DANGEROUS: Array<{ name: string; url: string }> = [
    { name: "javascript:", url: "javascript:alert(1)" },
    { name: "vbscript:", url: "vbscript:msgbox(1)" },
    { name: "file:", url: "file:///etc/passwd" },
    { name: "data:text/html", url: "data:text/html,<script>alert(1)</script>" },
    { name: "scheme-relative", url: "//evil.example.com/x.png" },
  ];

  for (const { name, url } of DANGEROUS) {
    it(`renders the neutralized unsafe card for a ${name} URL and never emits it`, () => {
      const { container } = render(
        <MessageAttachments
          attachments={[
            { id: "bad", url, contentType: "image", title: "evil" },
          ]}
        />,
      );
      // Degrades to the non-clickable unsafe card...
      expect(screen.getByTestId("unsafe-attachment")).not.toBeNull();
      // ...not an image/file/link that carries the dangerous URL.
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("a")).toBeNull();
      // The dangerous URL must appear in NO href/src anywhere in the DOM.
      const hrefs = Array.from(container.querySelectorAll("[href]")).map((el) =>
        el.getAttribute("href"),
      );
      const srcs = Array.from(container.querySelectorAll("[src]")).map((el) =>
        el.getAttribute("src"),
      );
      expect([...hrefs, ...srcs]).not.toContain(url);
    });
  }

  it("still renders safe sibling attachments alongside an unsafe one", () => {
    render(
      <MessageAttachments
        attachments={[
          { id: "bad", url: "javascript:alert(1)", contentType: "image" },
          {
            id: "ok",
            url: "https://x/cat.png",
            contentType: "image",
            title: "cat",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("unsafe-attachment")).not.toBeNull();
    // The safe image is unaffected — the guard is per-attachment, not all-or-nothing.
    expect(
      document.querySelector('img[src="https://x/cat.png"]'),
    ).not.toBeNull();
  });
});
