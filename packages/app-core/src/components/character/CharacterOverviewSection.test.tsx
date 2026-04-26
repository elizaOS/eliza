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
            body: <p>Chunk map</p>,
            isEmpty: false,
            section: "knowledge",
            title: "Knowledge",
          },
          {
            body: <p>People graph</p>,
            isEmpty: false,
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
