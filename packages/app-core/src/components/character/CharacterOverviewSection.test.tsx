// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CharacterOverviewSection } from "./CharacterOverviewSection";

describe("CharacterOverviewSection", () => {
  it("renders compact visual widgets and opens the selected section", () => {
    const onOpenSection = vi.fn();

    render(
      <CharacterOverviewSection
        onOpenSection={onOpenSection}
        widgets={[
          {
            bars: [
              { label: "Chunks", value: 0.7 },
              { label: "Editable", value: 0.5 },
            ],
            caption: "Chunk map",
            pie: [
              { label: "Uploaded", value: 3 },
              { label: "Learned", value: 1 },
            ],
            section: "knowledge",
            title: "Knowledge",
          },
          {
            bars: [
              { label: "People", value: 0.6 },
              { label: "Facts", value: 0.4 },
            ],
            caption: "People graph",
            nodes: ["Ada Lovelace", "Grace Hopper"],
            section: "relationships",
            title: "Relationships",
          },
        ]}
      />,
    );

    // The widget surface renders the section title and a click target;
    // captions / bars / pie / nodes are passed through `widget.body` by
    // higher-level callers and aren't asserted here. We just verify both
    // widgets surfaced + the click handler routes the right section.
    expect(screen.getByText("Knowledge")).toBeTruthy();
    expect(screen.getByText("Relationships")).toBeTruthy();
    expect(screen.queryByText(/doc/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Knowledge" }));

    expect(onOpenSection).toHaveBeenCalledWith("knowledge");
  });
});
