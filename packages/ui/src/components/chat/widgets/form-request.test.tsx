// @vitest-environment jsdom
//
// Renderer coverage for the [FORM] widget: the field-type → HTML input-type
// mapping (pure) and that temporal fields render native pickers and submit the
// browser's ISO-ish string value. jsdom + testing-library; no model, no network.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormRequestSpec } from "../message-form-parser";
import { FormRequest, htmlInputTypeForField } from "./form-request";

// This suite renders the same form in multiple cases; unmount between them so
// duplicate labels don't collide in `getByLabelText`.
afterEach(cleanup);

describe("htmlInputTypeForField", () => {
  it("maps each field type to the right native input type", () => {
    expect(htmlInputTypeForField("text")).toBe("text");
    expect(htmlInputTypeForField("number")).toBe("number");
    expect(htmlInputTypeForField("date")).toBe("date");
    expect(htmlInputTypeForField("time")).toBe("time");
    // `datetime` is the field type; the HTML control is `datetime-local`.
    expect(htmlInputTypeForField("datetime")).toBe("datetime-local");
  });
});

describe("FormRequest temporal fields", () => {
  const form: FormRequestSpec = {
    id: "sched",
    title: "Schedule reminder",
    submitLabel: "Create",
    fields: [
      { name: "day", type: "date", label: "Day", required: true },
      { name: "at", type: "time", label: "At" },
      { name: "when", type: "datetime", label: "When" },
    ],
  };

  it("renders native date/time/datetime-local inputs", () => {
    render(<FormRequest form={form} onSubmit={() => {}} />);
    expect((screen.getByLabelText("Day") as HTMLInputElement).type).toBe("date");
    expect((screen.getByLabelText("At") as HTMLInputElement).type).toBe("time");
    expect((screen.getByLabelText("When") as HTMLInputElement).type).toBe(
      "datetime-local",
    );
  });

  it("submits the picked values verbatim keyed by field name", () => {
    const onSubmit = vi.fn();
    render(<FormRequest form={form} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "2026-07-10" },
    });
    fireEvent.change(screen.getByLabelText("At"), {
      target: { value: "09:30" },
    });
    fireEvent.change(screen.getByLabelText("When"), {
      target: { value: "2026-07-10T09:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith("sched", {
      day: "2026-07-10",
      at: "09:30",
      when: "2026-07-10T09:30",
    });
  });
});

// #14489: an agent-emitted field named after an Object.prototype key
// (`constructor`, `hasOwnProperty`, `__proto__`) must not crash the transcript
// — the null-prototype value/error state turns them into ordinary fields.
describe("FormRequest prototype-polluting field names (#14489)", () => {
  it("renders a field named `constructor` as a working field without crashing", () => {
    const onSubmit = vi.fn();
    render(
      <FormRequest
        form={{
          id: "f",
          submitLabel: "Send",
          fields: [{ name: "constructor", type: "text", label: "Ctor" }],
        }}
        onSubmit={onSubmit}
      />,
    );
    // Before the fix, rendering threw (errors["constructor"] → Object ctor → .map).
    const input = screen.getByLabelText("Ctor") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith("f", { constructor: "hello" });
  });

  it("renders `__proto__` / `hasOwnProperty` fields without polluting or crashing", () => {
    const onSubmit = vi.fn();
    render(
      <FormRequest
        form={{
          id: "f2",
          submitLabel: "Go",
          fields: [
            { name: "__proto__", type: "text", label: "Proto" },
            { name: "hasOwnProperty", type: "text", label: "HasOwn" },
          ],
        }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText("Proto"), {
      target: { value: "a" },
    });
    fireEvent.change(screen.getByLabelText("HasOwn"), {
      target: { value: "b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    // No prototype pollution: a fresh plain object still has no own "a".
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][1] as Record<string, unknown>;
    expect(submitted.__proto__).toBe("a");
    expect(submitted.hasOwnProperty).toBe("b");
  });

  it("validates a required `constructor` field instead of crashing", () => {
    const onSubmit = vi.fn();
    render(
      <FormRequest
        form={{
          id: "f3",
          submitLabel: "Save",
          fields: [
            { name: "constructor", type: "text", label: "Ctor", required: true },
          ],
        }}
        onSubmit={onSubmit}
      />,
    );
    // Submitting empty must run validation (not crash) and block submit; the
    // field + button stay rendered (a crash would unmount the whole subtree).
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Ctor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});
