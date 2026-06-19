// @vitest-environment jsdom
//
// Render test for the shared chat MessageAttachments renderer: each media kind
// produces the right element (image / audio / video / file card), and clicking
// an image opens the full-screen lightbox.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageAttachment } from "../../api/client-types-chat";
import { MessageAttachments, resolveAttachmentUrl } from "./MessageAttachments";

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
        id: "doc",
        url: "https://x/report.pdf",
        contentType: "document",
        title: "report.pdf",
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
    const docLink = screen.getByRole("link", { name: /report\.pdf/i });
    expect(docLink.getAttribute("href")).toBe("https://x/report.pdf");
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
