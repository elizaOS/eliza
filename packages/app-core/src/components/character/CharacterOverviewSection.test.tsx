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

    expect(screen.getByText("Chunk map")).toBeTruthy();
    expect(screen.getByText("People graph")).toBeTruthy();
    expect(screen.queryByText(/doc/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Knowledge" }));

    expect(onOpenSection).toHaveBeenCalledWith("knowledge");
  });
});
