// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CharacterOverviewSection } from "./CharacterOverviewSection";

describe("CharacterOverviewSection", () => {
  it("renders compact visual widgets and opens the selected section", () => {
    const onOpenSection = vi.fn();
    const body = (caption: string): ReactNode => <div>{caption}</div>;

    render(
      <CharacterOverviewSection
        onOpenSection={onOpenSection}
        widgets={[
          {
            body: body("Chunk map"),
            isEmpty: false,
            section: "knowledge",
            title: "Knowledge",
          },
          {
            body: body("People graph"),
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
