/** Tests canonical polymorphism and branded variants with the real Radix adapters. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./badge";
import { Button } from "./button";
import { Card } from "./card";
import { Input } from "./input";
import { NativeDialog } from "./native-dialog";
import { NativeSelect } from "./native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

afterEach(cleanup);

describe("canonical atom composition", () => {
  it("applies badge semantics to a link without an extra host element", () => {
    render(
      <Badge asChild variant="outline">
        <a href="/docs">Docs</a>
      </Badge>,
    );

    const link = screen.getByRole("link", { name: "Docs" });
    expect(link.tagName).toBe("A");
    expect(link.classList.contains("border-border")).toBe(true);
  });

  it("applies the brand card variant through a polymorphic child", () => {
    render(
      <Card asChild variant="brand">
        <section aria-label="Agent summary">Body</section>
      </Card>,
    );

    const card = screen.getByRole("region", { name: "Agent summary" });
    expect(card.tagName).toBe("SECTION");
    expect(card.classList.contains("bg-bg-elevated")).toBe(true);
  });

  it("renders branded tabs through the canonical Radix owner", () => {
    render(
      <Tabs defaultValue="one">
        <TabsList variant="brand">
          <TabsTrigger variant="brand" value="one">
            One
          </TabsTrigger>
        </TabsList>
        <TabsContent value="one">Panel</TabsContent>
      </Tabs>,
    );

    expect(
      screen.getByRole("tablist").classList.contains("bg-bg-elevated"),
    ).toBe(true);
    expect(
      screen.getByRole("tab", { name: "One" }).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel");
  });

  it("renders selected choices through a typed state contract", () => {
    render(
      <Button variant="choice" data-state="on" aria-pressed="true">
        Selected route
      </Button>,
    );

    const choice = screen.getByRole("button", { name: "Selected route" });
    expect(choice.classList.contains("data-[state=on]:border-accent")).toBe(
      true,
    );
    expect(choice.getAttribute("aria-pressed")).toBe("true");
  });

  it("reserves canonical spacing for a leading input adornment", () => {
    render(<Input aria-label="Search" adornment="leading" />);

    expect(screen.getByRole("textbox", { name: "Search" }).classList).toContain(
      "pl-10",
    );
  });

  it("preserves native select semantics for platform pickers", () => {
    render(
      <NativeSelect aria-label="Country" presentation="overlay">
        <option value="in">India</option>
      </NativeSelect>,
    );

    const select = screen.getByRole("combobox", { name: "Country" });
    expect(select.tagName).toBe("SELECT");
    expect(select.classList).toContain("opacity-0");
  });

  it("forwards the native dialog host and accessibility contract", () => {
    const ref = { current: null as HTMLDialogElement | null };
    render(
      <NativeDialog ref={ref} aria-label="Contact Eliza">
        Contact options
      </NativeDialog>,
    );

    const dialog = screen.getByLabelText("Contact Eliza");
    expect(dialog.tagName).toBe("DIALOG");
    expect(ref.current).toBe(dialog);
  });
});
