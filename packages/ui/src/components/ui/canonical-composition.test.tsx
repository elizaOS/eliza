/** Tests canonical polymorphism and branded variants with the real Radix adapters. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./badge";
import { Card } from "./card";
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
});
