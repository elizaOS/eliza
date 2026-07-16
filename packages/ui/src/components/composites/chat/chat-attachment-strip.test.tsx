/**
 * Verifies the pending-attachment strip's compact geometry, horizontal scroll
 * treatment, media variants, and remove-control contract in the real shared
 * primitive composition.
 *
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatAttachmentStrip } from "./chat-attachment-strip";
import type { ChatAttachmentItem } from "./chat-types";

const items: ChatAttachmentItem[] = [
  {
    id: "image-1",
    name: "forest.png",
    alt: "A misty forest",
    src: "data:image/png;base64,forest",
    kind: "image",
  },
  {
    id: "audio-1",
    name: "memo.wav",
    alt: "Voice memo",
    src: "data:audio/wav;base64,memo",
    kind: "audio",
  },
];

afterEach(cleanup);

describe("ChatAttachmentStrip", () => {
  it("renders nothing without pending attachments", () => {
    const { container } = render(
      <ChatAttachmentStrip items={[]} onRemove={vi.fn()} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("uses the compact attachment primitives in a fading horizontal scroller", () => {
    const { container } = render(
      <ChatAttachmentStrip items={items} onRemove={vi.fn()} />,
    );

    const group = container.querySelector('[data-slot="attachment-group"]');
    expect(group).not.toBeNull();
    expect(group?.hasAttribute("data-scroll-cert-scroller")).toBe(true);
    expect(group?.className).toContain("scroll-fade-x");
    expect(group?.className).toContain("overflow-x-auto");

    const attachments = container.querySelectorAll('[data-slot="attachment"]');
    expect(attachments).toHaveLength(2);
    expect(attachments[0]?.getAttribute("data-size")).toBe("xs");
    expect(attachments[0]?.className).toContain("h-16");
    expect(attachments[0]?.className).toContain("w-16");

    expect(screen.getByAltText("A misty forest")).toBeTruthy();
    expect(screen.getByTitle("memo.wav").textContent).toBe("memo.wav");
  });

  it("preserves the remove callback, custom label, and coarse-pointer hit floor", () => {
    const onRemove = vi.fn();
    render(
      <ChatAttachmentStrip
        items={items}
        onRemove={onRemove}
        removeLabel={(item) => `Discard ${item.name}`}
      />,
    );

    const remove = screen.getByRole("button", { name: "Discard memo.wav" });
    expect(remove.className).toContain("pointer-coarse:min-h-touch");
    expect(remove.className).toContain("pointer-coarse:min-w-touch");
    fireEvent.click(remove);

    expect(onRemove).toHaveBeenCalledWith("audio-1", 1);
  });

  it("retains game-modal pointer ownership and surface remove styling", () => {
    const { container } = render(
      <ChatAttachmentStrip
        items={[items[0]]}
        onRemove={vi.fn()}
        variant="game-modal"
      />,
    );

    const group = container.querySelector('[data-slot="attachment-group"]');
    expect(group?.getAttribute("data-no-camera-drag")).toBe("true");
    expect(group?.className).toContain("pointer-events-auto");
    expect(screen.getByRole("button").className).toContain(
      "bg-destructive-subtle",
    );
  });
});
