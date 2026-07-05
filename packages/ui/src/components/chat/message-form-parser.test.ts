// Unit tests for the `[FORM]` marker parser: JSON form-body parsing (mixed
// field types, MAX_FORM_FIELDS cap, malformed input) and region detection.
// Pure functions over string fixtures — no model, no render.

import { describe, expect, it } from "vitest";
import {
  findFormRegions,
  MAX_FORM_FIELDS,
  parseFormBody,
} from "./message-form-parser";

describe("parseFormBody", () => {
  it("parses a full form with mixed field types", () => {
    const form = parseFormBody(
      JSON.stringify({
        id: "feedback",
        title: "Feedback",
        description: "Tell us more",
        submitLabel: "Send",
        fields: [
          { name: "name", type: "text", label: "Name", required: true },
          { name: "rating", type: "number", placeholder: "1-5" },
          {
            name: "topic",
            type: "select",
            options: [{ label: "Bug", value: "bug" }, { value: "idea" }],
          },
          { name: "subscribe", type: "checkbox", label: "Subscribe" },
        ],
      }),
    );
    expect(form).not.toBeNull();
    expect(form?.id).toBe("feedback");
    expect(form?.submitLabel).toBe("Send");
    expect(form?.fields).toHaveLength(4);
    expect(form?.fields[0]).toEqual({
      name: "name",
      type: "text",
      label: "Name",
      required: true,
    });
    // select option without a label falls back to its value
    expect(form?.fields[2].options).toEqual([
      { label: "Bug", value: "bug" },
      { label: "idea", value: "idea" },
    ]);
  });

  it("defaults submitLabel and generates an id when omitted", () => {
    const form = parseFormBody(
      JSON.stringify({ fields: [{ name: "x", type: "text" }] }),
    );
    expect(form?.submitLabel).toBe("Submit");
    expect(form?.id.length).toBeGreaterThan(0);
  });

  it("defaults an unknown field type to text", () => {
    const form = parseFormBody(
      JSON.stringify({ fields: [{ name: "x", type: "color" }] }),
    );
    expect(form?.fields[0].type).toBe("text");
  });

  it("preserves the temporal field types (date, time, datetime)", () => {
    const form = parseFormBody(
      JSON.stringify({
        fields: [
          { name: "day", type: "date", label: "Day", required: true },
          { name: "at", type: "time", label: "At" },
          { name: "when", type: "datetime", label: "When" },
        ],
      }),
    );
    expect(form?.fields.map((f) => f.type)).toEqual([
      "date",
      "time",
      "datetime",
    ]);
    expect(form?.fields[0]).toEqual({
      name: "day",
      type: "date",
      label: "Day",
      required: true,
    });
  });

  it("drops fields with unsafe or missing names and dedupes by name", () => {
    const form = parseFormBody(
      JSON.stringify({
        fields: [
          { name: "__proto__", type: "text" },
          { name: "1bad", type: "text" },
          { type: "text" },
          { name: "ok", type: "text", label: "First" },
          { name: "ok", type: "number", label: "Dup" },
        ],
      }),
    );
    expect(form?.fields).toHaveLength(1);
    expect(form?.fields[0]).toEqual({
      name: "ok",
      type: "text",
      label: "First",
    });
  });

  it("returns null for malformed or empty input rather than throwing", () => {
    expect(parseFormBody("not json")).toBeNull();
    expect(parseFormBody("[]")).toBeNull();
    expect(parseFormBody("{}")).toBeNull();
    expect(parseFormBody(JSON.stringify({ fields: [] }))).toBeNull();
    expect(
      parseFormBody(JSON.stringify({ fields: [{ type: "text" }] })),
    ).toBeNull();
  });

  it("caps the number of fields", () => {
    const fields = Array.from({ length: MAX_FORM_FIELDS + 5 }, (_, i) => ({
      name: `f${i}`,
      type: "text",
    }));
    const form = parseFormBody(JSON.stringify({ fields }));
    expect(form?.fields).toHaveLength(MAX_FORM_FIELDS);
  });
});

describe("findFormRegions", () => {
  it("locates a FORM block and exposes its character region", () => {
    const body = JSON.stringify({ fields: [{ name: "x", type: "text" }] });
    const text = `Fill this out:\n[FORM]\n${body}\n[/FORM]`;
    const regions = findFormRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].form.fields[0].name).toBe("x");
    expect(text.slice(regions[0].start, regions[0].end)).toContain("[FORM]");
  });

  it("ignores a FORM block with a malformed body", () => {
    expect(findFormRegions("[FORM]\nnot json\n[/FORM]")).toEqual([]);
  });
});
