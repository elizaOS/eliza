/** Tests canonical polymorphism and branded variants with the real Radix adapters. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(choice.classList).toContain("data-[state=on]:bg-accent");
    expect(choice.classList).toContain("disabled:opacity-40");
    expect(choice.classList).toContain("data-[state=on]:disabled:opacity-100");
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

  it("preserves native range semantics through a typed presentation", () => {
    render(
      <Input
        type="range"
        variant="nativeRange"
        aria-label="Volume"
        defaultValue="40"
      />,
    );

    const slider = screen.getByRole("slider", { name: "Volume" });
    expect(slider.tagName).toBe("INPUT");
    expect(slider.classList).toContain("accent-accent");
  });

  it("keeps hidden native file machinery in the document", () => {
    render(
      <Input
        type="file"
        variant="nativeFileHidden"
        aria-label="Upload avatar"
      />,
    );

    const input = screen.getByLabelText("Upload avatar");
    expect(input.getAttribute("type")).toBe("file");
    expect(input.classList).toContain("sr-only");
  });

  it("connects display-none file machinery to an imperative trigger", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(
      <>
        <Input
          ref={inputRef}
          type="file"
          variant="nativeFileDisplayNone"
          aria-label="Choose attachment"
          onChange={onChange}
        />
        <Button type="button" onClick={() => inputRef.current?.click()}>
          Choose file
        </Button>
      </>,
    );

    const input = screen.getByLabelText("Choose attachment");
    const click = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Choose file" }));
    expect(click).toHaveBeenCalledOnce();
    expect(inputRef.current).toBe(input);

    const attachment = new File(["hello"], "hello.txt", {
      type: "text/plain",
    });
    await user.upload(input, attachment);
    expect(onChange).toHaveBeenCalledOnce();
    expect(inputRef.current?.files?.[0]?.name).toBe("hello.txt");
  });

  it("forwards color value, change, focus, ref, and disabled semantics", async () => {
    const user = userEvent.setup();
    const colorRef = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(
      <Input
        ref={colorRef}
        type="color"
        variant="nativeColor"
        aria-label="Accent color"
        defaultValue="#ff7a1a"
        onChange={onChange}
      />,
    );

    const color = screen.getByLabelText("Accent color");
    color.focus();
    expect(colorRef.current).toBe(color);
    expect(document.activeElement).toBe(color);
    fireEvent.change(color, { target: { value: "#112233" } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(colorRef.current?.value).toBe("#112233");

    colorRef.current?.blur();
    colorRef.current?.setAttribute("disabled", "");
    await user.click(color);
    expect(document.activeElement).not.toBe(color);
  });

  it("preserves range focus, keyboard, change, ref, and disabled semantics", async () => {
    const user = userEvent.setup();
    const rangeRef = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <Input
        ref={rangeRef}
        type="range"
        variant="nativeRange"
        aria-label="Playback position"
        min="0"
        max="100"
        defaultValue="25"
        onChange={onChange}
        onKeyDown={onKeyDown}
      />,
    );

    const range = screen.getByRole("slider", { name: "Playback position" });
    await user.click(range);
    expect(rangeRef.current).toBe(range);
    expect(document.activeElement).toBe(range);
    await user.keyboard("{ArrowRight}");
    expect(onKeyDown).toHaveBeenCalledOnce();
    fireEvent.change(range, { target: { value: "30" } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(rangeRef.current?.value).toBe("30");

    rangeRef.current?.blur();
    rangeRef.current?.setAttribute("disabled", "");
    await user.click(range);
    expect(document.activeElement).not.toBe(range);
  });
});
