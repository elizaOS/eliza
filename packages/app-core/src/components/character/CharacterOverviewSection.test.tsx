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

    expect(screen.getByText("Chunk map")).toBeTruthy();
    expect(screen.getByText("People graph")).toBeTruthy();
    expect(screen.queryByText(/doc/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Knowledge" }));

    expect(onOpenSection).toHaveBeenCalledWith("knowledge");
  });
});
