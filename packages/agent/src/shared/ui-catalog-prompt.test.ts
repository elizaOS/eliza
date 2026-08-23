/**
 * Unit tests for the static UI catalog prompt blocks and the catalog
 * renderer/assembler. Drives the real module: component listing, include
 * filtering, required-prop/slot rendering, and generate vs chat assembly.
 */

import { describe, expect, it } from "vitest";

import {
  COMPONENT_CATALOG,
  formatComponentCatalogForPrompt,
  generateCatalogPrompt,
  getComponentNames,
  UI_BINDING_DOCS,
  UI_DATA_BINDING,
  UI_EVENTS,
  UI_EXAMPLE_CHAT,
  UI_EXAMPLE_GENERATE,
  UI_INSTRUCTION_HEADER_CHAT,
  UI_INSTRUCTION_HEADER_GENERATE,
  UI_PATCH_FORMAT,
  UI_REPEAT,
  UI_STATE_BINDING,
  UI_VALIDATION,
  UI_VISIBILITY,
} from "./ui-catalog-prompt.ts";

const CATALOG_ORDER = [
  "Stack",
  "Grid",
  "Card",
  "Separator",
  "Heading",
  "Text",
  "Input",
  "Textarea",
  "Select",
  "Checkbox",
  "Radio",
  "Switch",
  "Slider",
  "Toggle",
  "ToggleGroup",
  "ButtonGroup",
  "Table",
  "Carousel",
  "Badge",
  "Avatar",
  "Image",
  "Alert",
  "Progress",
  "Rating",
  "Skeleton",
  "Spinner",
  "Button",
  "Link",
  "DropdownMenu",
  "Tabs",
  "Pagination",
  "Metric",
  "BarGraph",
  "LineGraph",
  "Tooltip",
  "Popover",
  "Collapsible",
  "Accordion",
  "Dialog",
  "Drawer",
] as const;

const SLOTTED_COMPONENTS = [
  "Stack",
  "Grid",
  "Card",
  "Collapsible",
  "Dialog",
  "Drawer",
] as const;

describe("getComponentNames", () => {
  it("returns every catalog key in insertion order", () => {
    expect(getComponentNames()).toEqual([...CATALOG_ORDER]);
  });

  it("returns unique names and matches Object.keys of the live catalog", () => {
    const names = getComponentNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(Object.keys(COMPONENT_CATALOG));
  });
});

describe("COMPONENT_CATALOG", () => {
  it("gives every component a description and a props record", () => {
    for (const name of CATALOG_ORDER) {
      const meta = COMPONENT_CATALOG[name];
      expect(meta, name).toBeDefined();
      expect(meta.description.length).toBeGreaterThan(0);
      expect(Object.keys(meta.props).length).toBeGreaterThan(0);
    }
  });

  it("marks the documented required props and leaves the rest optional", () => {
    const requiredByComponent: Record<string, string[]> = {
      Heading: ["text"],
      Text: ["text"],
      Select: ["options"],
      Checkbox: ["label"],
      Radio: ["name", "options"],
      ToggleGroup: ["items"],
      ButtonGroup: ["buttons"],
      Table: ["columns", "rows"],
      Carousel: ["items"],
      Badge: ["text"],
      Avatar: ["name"],
      Progress: ["value"],
      Rating: ["value"],
      Link: ["href"],
      DropdownMenu: ["items"],
      Tabs: ["tabs"],
      Pagination: ["totalPages"],
      Metric: ["label", "value"],
      BarGraph: ["data"],
      LineGraph: ["data"],
      Tooltip: ["content"],
      Popover: ["content"],
      Accordion: ["items"],
      Dialog: ["openPath"],
      Drawer: ["openPath"],
    };

    for (const [name, meta] of Object.entries(COMPONENT_CATALOG)) {
      const expected = requiredByComponent[name] ?? [];
      const actual = Object.entries(meta.props)
        .filter(([, info]) => info.required)
        .map(([prop]) => prop);
      expect(actual, name).toEqual(expected);
    }
  });

  it("exposes a default slot only on layout and overlay containers", () => {
    for (const [name, meta] of Object.entries(COMPONENT_CATALOG)) {
      if ((SLOTTED_COMPONENTS as readonly string[]).includes(name)) {
        expect(meta.slots, name).toEqual(["default"]);
      } else {
        expect(meta.slots, name).toBeUndefined();
      }
    }
  });
});

describe("formatComponentCatalogForPrompt", () => {
  it("renders the full catalog under the default heading and count", () => {
    const rendered = formatComponentCatalogForPrompt();
    expect(rendered.startsWith("## Available components (40)\n\n")).toBe(true);
    for (const name of CATALOG_ORDER) {
      expect(rendered).toContain(`- **${name}**: `);
    }
  });

  it("treats an omitted or empty options object the same as no argument", () => {
    const bare = formatComponentCatalogForPrompt();
    expect(formatComponentCatalogForPrompt(undefined)).toBe(bare);
    expect(formatComponentCatalogForPrompt({})).toBe(bare);
  });

  it("renders an empty include list as a zero-count heading with no entries", () => {
    const rendered = formatComponentCatalogForPrompt({ include: [] });
    expect(rendered).toBe("## Available components (0)\n\n");
  });

  it("ignores names that are not in the catalog", () => {
    const rendered = formatComponentCatalogForPrompt({
      include: ["NotAComponent", "AlsoMissing"],
    });
    expect(rendered).toBe("## Available components (0)\n\n");
  });

  it("renders a single included component and ignores unknown names beside it", () => {
    const rendered = formatComponentCatalogForPrompt({
      include: ["Missing", "Button"],
    });
    expect(rendered.startsWith("## Available components (1)\n\n")).toBe(true);
    expect(rendered).toContain("- **Button**:");
    expect(rendered).not.toContain("- **Stack**:");
    expect(rendered).not.toContain("Missing");
  });

  it("keeps catalog insertion order even when include is reversed", () => {
    const rendered = formatComponentCatalogForPrompt({
      include: ["Drawer", "Button", "Stack"],
    });
    const stackAt = rendered.indexOf("- **Stack**:");
    const buttonAt = rendered.indexOf("- **Button**:");
    const drawerAt = rendered.indexOf("- **Drawer**:");
    expect(stackAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(stackAt);
    expect(drawerAt).toBeGreaterThan(buttonAt);
    expect(rendered.startsWith("## Available components (3)\n\n")).toBe(true);
  });

  it("overrides the section heading, including an empty heading string", () => {
    const custom = formatComponentCatalogForPrompt({
      heading: "## Form kit",
      include: ["Input"],
    });
    expect(custom.startsWith("## Form kit (1)\n\n")).toBe(true);
    expect(custom).not.toContain("## Available components");

    const emptyHeading = formatComponentCatalogForPrompt({
      heading: "",
      include: ["Input"],
    });
    expect(emptyHeading.startsWith(" (1)\n\n")).toBe(true);
  });

  it("marks required props and omits the marker on optional ones", () => {
    const select = formatComponentCatalogForPrompt({ include: ["Select"] });
    expect(select).toContain(
      "    - options: Array<{ label: string; value: string }> (required) -- Array of selectable options",
    );
    expect(select).toContain("    - label: string -- Select label");
    expect(select).not.toContain("label: string (required)");

    const radio = formatComponentCatalogForPrompt({ include: ["Radio"] });
    expect(radio).toContain("    - name: string (required) --");
    expect(radio).toContain(
      "    - options: Array<{ label: string; value: string }> (required) --",
    );
  });

  it("renders slot lines for containers and 'No children.' otherwise", () => {
    const card = formatComponentCatalogForPrompt({ include: ["Card"] });
    expect(card).toContain("  Slots: default (accepts children)");
    expect(card).not.toContain("No children.");

    const heading = formatComponentCatalogForPrompt({ include: ["Heading"] });
    expect(heading).toContain("  No children.");
    expect(heading).not.toContain("Slots:");
  });

  it("mirrors live catalog metadata for every component's props and slots", () => {
    for (const [name, meta] of Object.entries(COMPONENT_CATALOG)) {
      const rendered = formatComponentCatalogForPrompt({ include: [name] });
      expect(rendered).toContain(`- **${name}**: ${meta.description}`);
      for (const [prop, info] of Object.entries(meta.props)) {
        const req = info.required ? " (required)" : "";
        expect(rendered).toContain(
          `    - ${prop}: ${info.type}${req} -- ${info.description}`,
        );
      }
      if (meta.slots) {
        expect(rendered).toContain(
          `  Slots: ${meta.slots.join(", ")} (accepts children)`,
        );
      } else {
        expect(rendered).toContain("  No children.");
      }
    }
  });
});

describe("static instruction blocks", () => {
  it("keeps generate and chat headers on distinct output contracts", () => {
    expect(UI_INSTRUCTION_HEADER_GENERATE).toContain("Output ONLY the patches");
    expect(UI_INSTRUCTION_HEADER_GENERATE).not.toContain(
      "respond conversationally first",
    );
    expect(UI_INSTRUCTION_HEADER_CHAT).toContain(
      "respond conversationally first",
    );
    expect(UI_INSTRUCTION_HEADER_CHAT).toContain(
      "Never emit patches unless they genuinely add value",
    );
  });

  it("documents patch paths, element schema, and emit order", () => {
    expect(UI_PATCH_FORMAT).toContain('{"op":"add","path":"/root"');
    expect(UI_PATCH_FORMAT).toContain("`/root`");
    expect(UI_PATCH_FORMAT).toContain("`/elements/<id>`");
    expect(UI_PATCH_FORMAT).toContain("`/state/<key>`");
    expect(UI_PATCH_FORMAT).toContain("Always emit `/root` first");
  });

  it("joins the six binding sections in documented order", () => {
    expect(UI_BINDING_DOCS).toBe(
      [
        UI_DATA_BINDING,
        UI_STATE_BINDING,
        UI_VISIBILITY,
        UI_VALIDATION,
        UI_EVENTS,
        UI_REPEAT,
      ].join("\n\n"),
    );
    expect(UI_DATA_BINDING).toContain('"$data.path.to.value"');
    expect(UI_STATE_BINDING).toContain("statePath");
    expect(UI_VISIBILITY).toContain('"operator": "eq"');
    expect(UI_VALIDATION).toContain('"fn": "required"');
    expect(UI_EVENTS).toContain('"action": "submitForm"');
    expect(UI_REPEAT).toContain('"path": "users"');
  });

  it("keeps generate and chat examples on their own modes", () => {
    expect(UI_EXAMPLE_GENERATE).toContain("## Example — generate mode");
    expect(UI_EXAMPLE_GENERATE).toContain('"path":"/root"');
    expect(UI_EXAMPLE_CHAT).toContain("## Example — chat mode");
    expect(UI_EXAMPLE_CHAT).toContain("text-only reply — no patches needed");
  });
});

describe("generateCatalogPrompt", () => {
  it("defaults to generate mode, full catalog, no extra rules, no examples", () => {
    const prompt = generateCatalogPrompt();
    expect(prompt.startsWith(UI_INSTRUCTION_HEADER_GENERATE)).toBe(true);
    expect(prompt).toContain(UI_PATCH_FORMAT);
    expect(prompt).toContain(formatComponentCatalogForPrompt());
    expect(prompt).toContain(UI_BINDING_DOCS);
    expect(prompt).not.toContain("## Additional rules");
    expect(prompt).not.toContain(UI_EXAMPLE_GENERATE);
    expect(prompt).not.toContain(UI_EXAMPLE_CHAT);
    expect(prompt).not.toContain(UI_INSTRUCTION_HEADER_CHAT);
    expect(prompt).toBe(generateCatalogPrompt({ mode: "generate" }));
    expect(prompt).toBe(generateCatalogPrompt({}));
  });

  it("switches the header and withholds generate-only wording in chat mode", () => {
    const prompt = generateCatalogPrompt({ mode: "chat" });
    expect(prompt.startsWith(UI_INSTRUCTION_HEADER_CHAT)).toBe(true);
    expect(prompt).not.toContain(UI_INSTRUCTION_HEADER_GENERATE);
    expect(prompt).toContain(UI_PATCH_FORMAT);
    expect(prompt).toContain(UI_BINDING_DOCS);
  });

  it("omits the additional-rules section for a missing or empty customRules list", () => {
    expect(generateCatalogPrompt({ customRules: [] })).not.toContain(
      "## Additional rules",
    );
    expect(generateCatalogPrompt()).not.toContain("## Additional rules");
  });

  it("appends custom rules as a markdown list", () => {
    const prompt = generateCatalogPrompt({
      customRules: ["Never nest Dialog in Drawer", "Prefer Metric for KPIs"],
    });
    expect(prompt).toContain(
      "## Additional rules\n\n- Never nest Dialog in Drawer\n- Prefer Metric for KPIs",
    );
    expect(prompt.endsWith("- Prefer Metric for KPIs")).toBe(true);
  });

  it("appends the generate example only when includeExamples is true", () => {
    const withExample = generateCatalogPrompt({ includeExamples: true });
    expect(withExample).toContain(UI_EXAMPLE_GENERATE);
    expect(withExample).not.toContain(UI_EXAMPLE_CHAT);
    expect(withExample.endsWith(UI_EXAMPLE_GENERATE)).toBe(true);

    expect(generateCatalogPrompt({ includeExamples: false })).not.toContain(
      UI_EXAMPLE_GENERATE,
    );
  });

  it("appends the chat example in chat mode when includeExamples is true", () => {
    const prompt = generateCatalogPrompt({
      mode: "chat",
      includeExamples: true,
    });
    expect(prompt).toContain(UI_EXAMPLE_CHAT);
    expect(prompt).not.toContain(UI_EXAMPLE_GENERATE);
    expect(prompt.endsWith(UI_EXAMPLE_CHAT)).toBe(true);
  });

  it("passes componentFilter through to the catalog renderer", () => {
    const prompt = generateCatalogPrompt({
      componentFilter: ["Metric", "NotInCatalog", "Slider"],
    });
    const catalog = formatComponentCatalogForPrompt({
      include: ["Metric", "NotInCatalog", "Slider"],
    });
    expect(prompt).toContain(catalog);
    expect(prompt).toContain("## Available components (2)");
    expect(prompt).toContain("- **Slider**:");
    expect(prompt).toContain("- **Metric**:");
    expect(prompt).not.toContain("- **Button**:");
    expect(prompt.indexOf("- **Slider**:")).toBeLessThan(
      prompt.indexOf("- **Metric**:"),
    );
  });

  it("assembles every optional branch together without dropping sections", () => {
    const prompt = generateCatalogPrompt({
      mode: "chat",
      customRules: ["Keep forms short"],
      includeExamples: true,
      componentFilter: ["Input"],
    });
    expect(prompt.startsWith(UI_INSTRUCTION_HEADER_CHAT)).toBe(true);
    expect(prompt).toContain(UI_PATCH_FORMAT);
    expect(prompt).toContain(
      formatComponentCatalogForPrompt({ include: ["Input"] }),
    );
    expect(prompt).toContain(UI_BINDING_DOCS);
    expect(prompt).toContain("## Additional rules\n\n- Keep forms short");
    expect(prompt).toContain(UI_EXAMPLE_CHAT);
    expect(prompt).not.toContain(UI_EXAMPLE_GENERATE);
    expect(prompt).not.toContain(UI_INSTRUCTION_HEADER_GENERATE);
  });
});
