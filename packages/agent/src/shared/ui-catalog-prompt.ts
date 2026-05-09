/**
 * ui-catalog-prompt.ts -- Static instruction prompt + dynamic component
 * catalog used by LLMs to emit valid UiSpec JSON-patch output.
 *
 * The instruction prompt and the catalog are separate so callers can
 * include only what they need (e.g. only form components, or only the
 * patch format with no examples).
 *
 * Exports:
 *   - COMPONENT_CATALOG, ComponentMeta, getComponentNames — catalog data
 *   - UI_INSTRUCTION_HEADER_GENERATE / UI_INSTRUCTION_HEADER_CHAT —
 *       mode-specific opening sentence
 *   - UI_PATCH_FORMAT — patch format + path conventions + element schema
 *   - UI_BINDING_DOCS — data binding, state, visibility, validation,
 *       events, and repeat (composed from smaller named blocks)
 *   - UI_EXAMPLE_GENERATE / UI_EXAMPLE_CHAT — one canonical example each
 *   - formatComponentCatalogForPrompt(options?) — renders the catalog
 *   - generateCatalogPrompt(options?) — back-compat assembler
 */

// ── Component metadata types ────────────────────────────────────────

interface PropMeta {
  type: string;
  description: string;
  required?: boolean;
}

export interface ComponentMeta {
  description: string;
  props: Record<string, PropMeta>;
  slots?: string[];
}

// ══════════════════════════════════════════════════════════════════════
// COMPONENT CATALOG
// ══════════════════════════════════════════════════════════════════════

export const COMPONENT_CATALOG: Record<string, ComponentMeta> = {
  // ── Layout ──────────────────────────────────────────────────────────

  Stack: {
    description: "Flexbox container for vertical or horizontal layouts",
    props: {
      direction: {
        type: '"vertical" | "horizontal"',
        description: "Layout direction. Defaults to vertical.",
        required: false,
      },
      gap: {
        type: '"none" | "xs" | "sm" | "md" | "lg" | "xl"',
        description: "Gap between children. Defaults to md.",
        required: false,
      },
      align: {
        type: '"start" | "center" | "end" | "stretch"',
        description: "Cross-axis alignment. Defaults to stretch.",
        required: false,
      },
      justify: {
        type: '"start" | "center" | "end" | "between" | "around"',
        description: "Main-axis alignment. Defaults to start.",
        required: false,
      },
    },
    slots: ["default"],
  },

  Grid: {
    description: "CSS grid container with configurable columns",
    props: {
      columns: {
        type: "number",
        description: "Number of grid columns. Defaults to 2.",
        required: false,
      },
      gap: {
        type: '"none" | "xs" | "sm" | "md" | "lg" | "xl"',
        description: "Gap between grid cells. Defaults to md.",
        required: false,
      },
    },
    slots: ["default"],
  },

  Card: {
    description: "Bordered container with optional title and description",
    props: {
      title: {
        type: "string",
        description: "Card heading text",
        required: false,
      },
      description: {
        type: "string",
        description: "Card subtitle / description text",
        required: false,
      },
      maxWidth: {
        type: '"full" | undefined',
        description: 'Set to "full" for full-width card',
        required: false,
      },
    },
    slots: ["default"],
  },

  Separator: {
    description: "Horizontal or vertical divider line",
    props: {
      orientation: {
        type: '"horizontal" | "vertical"',
        description: "Divider direction. Defaults to horizontal.",
        required: false,
      },
    },
  },

  // ── Typography ──────────────────────────────────────────────────────

  Heading: {
    description: "Heading text with configurable level",
    props: {
      text: {
        type: "string",
        description: "Heading content",
        required: true,
      },
      level: {
        type: '"h1" | "h2" | "h3"',
        description: "Heading level. Defaults to h2.",
        required: false,
      },
    },
  },

  Text: {
    description: "Body text with variant styling",
    props: {
      text: {
        type: "string",
        description: "Text content",
        required: true,
      },
      variant: {
        type: '"body" | "caption" | "muted" | "lead" | "code"',
        description: "Text style variant. Defaults to body.",
        required: false,
      },
    },
  },

  // ── Form ────────────────────────────────────────────────────────────

  Input: {
    description: "Single-line text input with label and state binding",
    props: {
      label: {
        type: "string",
        description: "Input label displayed above the field",
        required: false,
      },
      type: {
        type: '"text" | "email" | "password" | "number" | "url" | "tel"',
        description: "HTML input type. Defaults to text.",
        required: false,
      },
      name: {
        type: "string",
        description: "Form field name attribute",
        required: false,
      },
      placeholder: {
        type: "string",
        description: "Placeholder text",
        required: false,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for two-way binding",
        required: false,
      },
    },
  },

  Textarea: {
    description: "Multi-line text input with configurable rows",
    props: {
      label: {
        type: "string",
        description: "Textarea label",
        required: false,
      },
      name: {
        type: "string",
        description: "Form field name attribute",
        required: false,
      },
      placeholder: {
        type: "string",
        description: "Placeholder text",
        required: false,
      },
      rows: {
        type: "number",
        description: "Number of visible rows. Defaults to 3.",
        required: false,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for two-way binding",
        required: false,
      },
    },
  },

  Select: {
    description: "Dropdown select with options list",
    props: {
      label: {
        type: "string",
        description: "Select label",
        required: false,
      },
      options: {
        type: "Array<{ label: string; value: string }>",
        description: "Array of selectable options",
        required: true,
      },
      placeholder: {
        type: "string",
        description: "Placeholder option text",
        required: false,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for two-way binding",
        required: false,
      },
    },
  },

  Checkbox: {
    description: "Single checkbox with label",
    props: {
      label: {
        type: "string",
        description: "Checkbox label text",
        required: true,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for two-way binding (boolean)",
        required: false,
      },
    },
  },

  Radio: {
    description: "Radio button group",
    props: {
      label: {
        type: "string",
        description: "Group label text",
        required: false,
      },
      name: {
        type: "string",
        description: "Radio group name for mutual exclusion",
        required: true,
      },
      options: {
        type: "Array<{ label: string; value: string }>",
        description: "Array of radio options",
        required: true,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for two-way binding",
        required: false,
      },
    },
  },

  Switch: {
    description: "Toggle switch for boolean values",
    props: {
      label: {
        type: "string",
        description: "Switch label text",
        required: false,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for two-way binding (boolean)",
        required: false,
      },
    },
  },

  Slider: {
    description: "Range slider input",
    props: {
      label: {
        type: "string",
        description: "Slider label text",
        required: false,
      },
      min: {
        type: "number",
        description: "Minimum value. Defaults to 0.",
        required: false,
      },
      max: {
        type: "number",
        description: "Maximum value. Defaults to 100.",
        required: false,
      },
      step: {
        type: "number",
        description: "Step increment. Defaults to 1.",
        required: false,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for two-way binding (number)",
        required: false,
      },
    },
  },

  Toggle: {
    description: "Pressable toggle button with on/off state",
    props: {
      label: {
        type: "string",
        description: "Toggle button label. Defaults to 'Toggle'.",
        required: false,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for two-way binding (boolean)",
        required: false,
      },
    },
  },

  ToggleGroup: {
    description: "Group of toggle buttons for single or multiple selection",
    props: {
      items: {
        type: "Array<{ label: string; value: string }>",
        description: "Selectable toggle items",
        required: true,
      },
      type: {
        type: '"single" | "multiple"',
        description:
          "Selection mode. Single selects one value, multiple allows many.",
        required: false,
      },
      statePath: {
        type: "string",
        description:
          "Dot-path into spec state. String for single, string[] for multiple.",
        required: false,
      },
    },
  },

  ButtonGroup: {
    description: "Row of mutually exclusive buttons (single selection)",
    props: {
      buttons: {
        type: "Array<{ label: string; value: string }>",
        description: "Button options",
        required: true,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for the selected value",
        required: false,
      },
    },
  },

  // ── Data Display ────────────────────────────────────────────────────

  Table: {
    description: "Data table with column headers and rows",
    props: {
      columns: {
        type: "string[]",
        description: "Array of column header names",
        required: true,
      },
      rows: {
        type: "string[][]",
        description: "2D array of row cell values",
        required: true,
      },
      caption: {
        type: "string",
        description: "Table caption displayed above",
        required: false,
      },
    },
  },

  Carousel: {
    description: "Paginated carousel that shows one item at a time",
    props: {
      items: {
        type: "Array<{ title: string; description: string }>",
        description: "Carousel slide items",
        required: true,
      },
    },
  },

  Badge: {
    description: "Small inline label / tag",
    props: {
      text: {
        type: "string",
        description: "Badge text content",
        required: true,
      },
      variant: {
        type: '"default" | "success" | "warning" | "error" | "info"',
        description: "Color variant. Defaults to default.",
        required: false,
      },
    },
  },

  Avatar: {
    description: "Circular avatar showing initials derived from a name",
    props: {
      name: {
        type: "string",
        description: "Full name used to generate initials",
        required: true,
      },
      size: {
        type: '"sm" | "md" | "lg"',
        description: "Avatar size. Defaults to md.",
        required: false,
      },
    },
  },

  Image: {
    description: "Image element with fallback placeholder",
    props: {
      src: {
        type: "string",
        description: "Image URL",
        required: false,
      },
      alt: {
        type: "string",
        description: "Alt text for accessibility",
        required: false,
      },
      width: {
        type: "number",
        description: "Width in pixels",
        required: false,
      },
      height: {
        type: "number",
        description: "Height in pixels",
        required: false,
      },
    },
  },

  // ── Feedback ────────────────────────────────────────────────────────

  Alert: {
    description: "Alert banner with type-based styling",
    props: {
      type: {
        type: '"info" | "success" | "warning" | "error"',
        description: "Alert severity. Defaults to info.",
        required: false,
      },
      title: {
        type: "string",
        description: "Alert title",
        required: false,
      },
      message: {
        type: "string",
        description: "Alert body text",
        required: false,
      },
    },
  },

  Progress: {
    description: "Horizontal progress bar",
    props: {
      value: {
        type: "number",
        description: "Current progress value",
        required: true,
      },
      max: {
        type: "number",
        description: "Maximum value. Defaults to 100.",
        required: false,
      },
      label: {
        type: "string",
        description: "Label displayed above the bar",
        required: false,
      },
    },
  },

  Rating: {
    description: "Star rating display",
    props: {
      value: {
        type: "number",
        description: "Number of filled stars",
        required: true,
      },
      max: {
        type: "number",
        description: "Total number of stars. Defaults to 5.",
        required: false,
      },
      label: {
        type: "string",
        description: "Label displayed above the stars",
        required: false,
      },
    },
  },

  Skeleton: {
    description: "Loading placeholder with pulse animation",
    props: {
      width: {
        type: "string",
        description: "CSS width value. Defaults to 100%.",
        required: false,
      },
      height: {
        type: "string",
        description: "CSS height value. Defaults to 20px.",
        required: false,
      },
      rounded: {
        type: "boolean",
        description: "Apply rounded corners",
        required: false,
      },
    },
  },

  Spinner: {
    description: "Spinning loading indicator",
    props: {
      size: {
        type: '"sm" | "md" | "lg"',
        description: "Spinner size. Defaults to md.",
        required: false,
      },
      label: {
        type: "string",
        description: "Loading text displayed beside the spinner",
        required: false,
      },
    },
  },

  // ── Navigation ──────────────────────────────────────────────────────

  Button: {
    description: "Clickable button with variant styling",
    props: {
      label: {
        type: "string",
        description: "Button text. Defaults to 'Button'.",
        required: false,
      },
      variant: {
        type: '"primary" | "secondary" | "danger" | "ghost"',
        description: "Button style variant. Defaults to primary.",
        required: false,
      },
      disabled: {
        type: "boolean",
        description: "Disable the button",
        required: false,
      },
    },
  },

  Link: {
    description: "Anchor link, optionally opening in a new tab",
    props: {
      label: {
        type: "string",
        description: "Link text",
        required: false,
      },
      href: {
        type: "string",
        description: "URL target",
        required: true,
      },
      external: {
        type: "boolean",
        description: "Open in new tab with noopener",
        required: false,
      },
    },
  },

  DropdownMenu: {
    description: "Button that reveals a dropdown list of actions",
    props: {
      label: {
        type: "string",
        description: "Trigger button text. Defaults to 'Menu'.",
        required: false,
      },
      items: {
        type: "Array<{ label: string; value: string }>",
        description: "Menu items. Selection fires a 'menuSelect' action.",
        required: true,
      },
    },
  },

  Tabs: {
    description: "Tabbed navigation with inline text content per tab",
    props: {
      tabs: {
        type: "Array<{ label: string; value: string; content: string }>",
        description: "Tab definitions with labels and text content",
        required: true,
      },
      defaultValue: {
        type: "string",
        description: "Initially active tab value",
        required: false,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for the active tab value",
        required: false,
      },
    },
  },

  Pagination: {
    description: "Page navigation with numbered buttons",
    props: {
      totalPages: {
        type: "number",
        description: "Total number of pages",
        required: true,
      },
      statePath: {
        type: "string",
        description: "Dot-path into spec state for the current page (number)",
        required: false,
      },
    },
  },

  // ── Metric / KPI display ────────────────────────────────────────────

  Metric: {
    description:
      "KPI / metric card showing a label, primary value, and optional change indicator. Ideal for wallet balances, prices, and stats.",
    props: {
      label: {
        type: "string",
        description: "Metric label (e.g. 'BNB Balance')",
        required: true,
      },
      value: {
        type: "string | number",
        description:
          'Primary display value. Supports dynamic { "$path": "state.path" } reference.',
        required: true,
      },
      unit: {
        type: "string",
        description: "Unit suffix after value (e.g. 'BNB', 'USD')",
        required: false,
      },
      change: {
        type: "string | number",
        description: "Change delta shown below value (e.g. '+2.4%')",
        required: false,
      },
      trend: {
        type: '"up" | "down" | "neutral"',
        description:
          "Trend direction — colours change indicator green/red/grey",
        required: false,
      },
    },
  },

  // ── Visualization ───────────────────────────────────────────────────

  BarGraph: {
    description: "Vertical bar chart",
    props: {
      data: {
        type: "Array<{ label: string; value: number }>",
        description: "Data points for the bars",
        required: true,
      },
      title: {
        type: "string",
        description: "Chart title",
        required: false,
      },
    },
  },

  LineGraph: {
    description: "SVG line chart",
    props: {
      data: {
        type: "Array<{ label: string; value: number }>",
        description: "Data points for the line",
        required: true,
      },
      title: {
        type: "string",
        description: "Chart title",
        required: false,
      },
    },
  },

  // ── Interaction ─────────────────────────────────────────────────────

  Tooltip: {
    description: "Hover tooltip showing extra information",
    props: {
      text: {
        type: "string",
        description: "Trigger text that the user hovers. Defaults to 'Hover'.",
        required: false,
      },
      content: {
        type: "string",
        description: "Tooltip popup content",
        required: true,
      },
    },
  },

  Popover: {
    description: "Click-triggered popup with content",
    props: {
      trigger: {
        type: "string",
        description: "Trigger text. Defaults to 'Click'.",
        required: false,
      },
      content: {
        type: "string",
        description: "Popover body content",
        required: true,
      },
    },
  },

  Collapsible: {
    description: "Expandable/collapsible content section",
    props: {
      title: {
        type: "string",
        description: "Header text. Defaults to 'Collapsible'.",
        required: false,
      },
      defaultOpen: {
        type: "boolean",
        description: "Start in open state",
        required: false,
      },
    },
    slots: ["default"],
  },

  Accordion: {
    description: "Multi-section accordion with expand/collapse",
    props: {
      items: {
        type: "Array<{ title: string; content: string }>",
        description: "Accordion sections",
        required: true,
      },
      type: {
        type: '"single" | "multiple"',
        description: "Whether only one section can be open at a time",
        required: false,
      },
    },
  },

  Dialog: {
    description: "Modal dialog controlled by a state path",
    props: {
      title: {
        type: "string",
        description: "Dialog title",
        required: false,
      },
      description: {
        type: "string",
        description: "Dialog description text",
        required: false,
      },
      openPath: {
        type: "string",
        description:
          "Dot-path into spec state (boolean) that controls open/close",
        required: true,
      },
    },
    slots: ["default"],
  },

  Drawer: {
    description: "Bottom drawer overlay controlled by a state path",
    props: {
      title: {
        type: "string",
        description: "Drawer title",
        required: false,
      },
      description: {
        type: "string",
        description: "Drawer description text",
        required: false,
      },
      openPath: {
        type: "string",
        description:
          "Dot-path into spec state (boolean) that controls open/close",
        required: true,
      },
    },
    slots: ["default"],
  },
};

// ══════════════════════════════════════════════════════════════════════
// CATALOG UTILITIES
// ══════════════════════════════════════════════════════════════════════

/** Returns the list of all component type names in the catalog. */
export function getComponentNames(): string[] {
  return Object.keys(COMPONENT_CATALOG);
}

export interface FormatComponentCatalogOptions {
  /** Render only these component types. Names not in the catalog are ignored. */
  include?: string[];
  /** Override the section heading. Defaults to "## Available components". */
  heading?: string;
}

/**
 * Renders the component catalog as a Markdown section suitable for
 * embedding in a system prompt. Pass `include` to render a subset.
 */
export function formatComponentCatalogForPrompt(
  options?: FormatComponentCatalogOptions,
): string {
  const include = options?.include;
  const heading = options?.heading ?? "## Available components";
  const entries = Object.entries(COMPONENT_CATALOG).filter(
    ([name]) => !include || include.includes(name),
  );

  const componentLines: string[] = [];
  for (const [name, meta] of entries) {
    const propDescs: string[] = [];
    for (const [prop, info] of Object.entries(meta.props)) {
      const req = info.required ? " (required)" : "";
      propDescs.push(
        `    - ${prop}: ${info.type}${req} -- ${info.description}`,
      );
    }
    const slotsLine = meta.slots
      ? `  Slots: ${meta.slots.join(", ")} (accepts children)`
      : "  No children.";
    componentLines.push(
      `- **${name}**: ${meta.description}\n  Props:\n${propDescs.join("\n")}\n${slotsLine}`,
    );
  }

  return `${heading} (${entries.length})\n\n${componentLines.join("\n\n")}`;
}

// ══════════════════════════════════════════════════════════════════════
// STATIC INSTRUCTION BLOCKS
// ══════════════════════════════════════════════════════════════════════

/** Opening sentence for "generate" mode (JSONL-only output). */
export const UI_INSTRUCTION_HEADER_GENERATE =
  "You are generating UI specifications as JSONL patches. Output ONLY the patches — one JSON object per line, no prose, no markdown, no code fences.";

/** Opening sentences for "chat" mode (prose + inline JSONL when useful). */
export const UI_INSTRUCTION_HEADER_CHAT = `You can generate interactive UI components inline in your responses using JSONL patches.

When the user's request calls for a form, chart, slider, metric display, wallet control, or any interactive element, respond conversationally first (one or two sentences), then emit the JSONL patches on their own lines immediately after. Each patch must be on its own line with no extra whitespace or code fences.

When no UI is needed (greetings, factual questions, clarifications) — reply with text only. Never emit patches unless they genuinely add value.`;

/** Patch wire format: ops, paths, element schema, ordering rules. */
export const UI_PATCH_FORMAT = `## Output format — JSONL patches (RFC 6902)

Each line of UI output is a single JSON patch operation:

\`\`\`
{"op":"add","path":"/root","value":"card-1"}
{"op":"add","path":"/elements/card-1","value":{"type":"Card","props":{"title":"My Form"},"children":["input-1","btn-1"]}}
{"op":"add","path":"/elements/input-1","value":{"type":"Input","props":{"label":"Amount","type":"number","statePath":"amount"},"children":[]}}
{"op":"add","path":"/elements/btn-1","value":{"type":"Button","props":{"label":"Submit"},"children":[]}}
{"op":"add","path":"/state/amount","value":0}
\`\`\`

**Path conventions:**
- \`/root\` — set the root element ID (required, must be first)
- \`/elements/<id>\` — add/replace an element
- \`/state/<key>\` — set initial state value
- \`/state\` — set the entire state object at once

**Element schema:**
\`\`\`
{
  "type": "<ComponentType>",
  "props": { ... },
  "children": ["child-id-1", "child-id-2"],
  "on": { ... },          // optional event bindings
  "visible": { ... },     // optional visibility condition
  "validation": { ... },  // optional validation
  "repeat": { ... }       // optional list rendering
}
\`\`\`

Always emit \`/root\` first, then all \`/elements\` entries, then \`/state\` values.
Element IDs must be unique kebab-case strings (e.g. \`send-btn\`, \`amount-slider\`).`;

/** Data binding section. */
export const UI_DATA_BINDING = `## Data binding

Reference state values dynamically in props using either syntax:

1. **String prefix**: \`"$data.path.to.value"\` -- the value at that state path is resolved at render time.
2. **Object syntax**: \`{ "$path": "path.to.value" }\` -- equivalent, useful when the value is not a string.

Inside a \`repeat\` block, reference the current item's fields with \`"$data.$item/fieldName"\` or \`{ "$path": "$item/fieldName" }\`.`;

/** State binding section. */
export const UI_STATE_BINDING = `## State binding

Form elements accept a \`statePath\` prop (dot-delimited path into \`state\`). This creates two-way binding: the element reads its current value from the path and writes back on user input. Example: \`"statePath": "form.email"\` binds to \`state.form.email\`.`;

/** Visibility section. */
export const UI_VISIBILITY = `## Visibility

Any element can have a \`visible\` condition. If it evaluates to false, the element is not rendered.

**Path-based condition:**
\`\`\`
{ "path": "form.role", "operator": "eq", "value": "admin" }
\`\`\`
Operators: eq, ne, gt, gte, lt, lte.

**Auth-based condition:**
\`\`\`
{ "auth": "signedIn" }
\`\`\`
Values: signedIn, signedOut, admin, or any custom role string.

**Logical combinators:**
\`\`\`
{ "and": [ <condition>, <condition> ] }
{ "or": [ <condition>, <condition> ] }
{ "not": <condition> }
\`\`\``;

/** Validation section. */
export const UI_VALIDATION = `## Validation

Form elements can declare a \`validation\` object:

\`\`\`
{
  "checks": [
    { "fn": "required", "message": "This field is required" },
    { "fn": "email", "message": "Enter a valid email" },
    { "fn": "minLength", "args": { "length": 3 }, "message": "At least 3 characters" }
  ],
  "validateOn": "blur"
}
\`\`\`

\`validateOn\`: "change" | "blur" | "submit" (defaults to submit).

Built-in validators:
- **required** -- value must not be null or empty string
- **email** -- must match email pattern
- **minLength** -- args: { length: number }
- **maxLength** -- args: { length: number }
- **pattern** -- args: { pattern: string } (regex)
- **min** -- args: { value: number }
- **max** -- args: { value: number }`;

/** Events section. */
export const UI_EVENTS = `## Events

Elements can have an \`on\` property mapping event names to actions:

\`\`\`
{
  "on": {
    "press": {
      "action": "submitForm",
      "params": { "formId": "contactForm" },
      "confirm": {
        "title": "Confirm submission",
        "message": "Are you sure?",
        "confirmLabel": "Yes",
        "cancelLabel": "No"
      },
      "onSuccess": { "action": "showToast", "params": { "message": "Saved!" } },
      "onError": { "action": "showToast", "params": { "message": "Failed." } }
    }
  }
}
\`\`\`

Common event names: press, change. The \`action\` string identifies the handler. \`params\`, \`confirm\`, \`onSuccess\`, and \`onError\` are all optional.`;

/** Repeat / list rendering section. */
export const UI_REPEAT = `## Repeat / list rendering

Render an element once per item in a state array:

\`\`\`
{
  "type": "Card",
  "props": { "title": "$data.$item/name" },
  "children": [],
  "repeat": { "path": "users", "key": "id" }
}
\`\`\`

- \`path\`: dot-path to an array in state.
- \`key\`: field name on each item used as the unique key.
- Inside the repeated element and its children, use \`$data.$item/fieldName\` or \`{ "$path": "$item/fieldName" }\` to reference item fields.`;

/**
 * All binding-related docs (data, state, visibility, validation, events,
 * repeat) joined for convenience. Callers that only need a subset can
 * import the individual blocks.
 */
export const UI_BINDING_DOCS = [
  UI_DATA_BINDING,
  UI_STATE_BINDING,
  UI_VISIBILITY,
  UI_VALIDATION,
  UI_EVENTS,
  UI_REPEAT,
].join("\n\n");

// ══════════════════════════════════════════════════════════════════════
// EXAMPLES
// ══════════════════════════════════════════════════════════════════════

/** Canonical example for "generate" mode. */
export const UI_EXAMPLE_GENERATE = `## Example — generate mode

\`\`\`
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Contact Us"},"children":["heading","desc","email-input","submit-btn"]}}
{"op":"add","path":"/elements/heading","value":{"type":"Heading","props":{"text":"Get in Touch","level":"h2"},"children":[]}}
{"op":"add","path":"/elements/desc","value":{"type":"Text","props":{"text":"Fill out the form and we will respond within 24 hours.","variant":"muted"},"children":[]}}
{"op":"add","path":"/elements/email-input","value":{"type":"Input","props":{"label":"Email","type":"email","placeholder":"you@example.com","statePath":"form.email"},"children":[],"validation":{"checks":[{"fn":"required","message":"Email is required"},{"fn":"email","message":"Enter a valid email"}],"validateOn":"blur"}}}
{"op":"add","path":"/elements/submit-btn","value":{"type":"Button","props":{"label":"Send Message","variant":"primary"},"children":[],"on":{"press":{"action":"submitContact","params":{"email":{"$path":"form.email"}}}}}}
{"op":"add","path":"/state/form","value":{"email":""}}
\`\`\``;

/** Canonical example for "chat" mode (prose + JSONL + a text-only reply). */
export const UI_EXAMPLE_CHAT = `## Example — chat mode

User: "Help me send some BNB to a friend"

Your response:

\`\`\`
Sure! Here's a quick send form — enter the amount and recipient address:

{"op":"add","path":"/root","value":"send-card"}
{"op":"add","path":"/elements/send-card","value":{"type":"Card","props":{"title":"Send BNB"},"children":["amount-slider","amount-display","addr-input","send-btn"]}}
{"op":"add","path":"/elements/amount-slider","value":{"type":"Slider","props":{"label":"Amount (BNB)","min":0,"max":10,"step":0.01,"statePath":"amount"},"children":[]}}
{"op":"add","path":"/elements/amount-display","value":{"type":"Metric","props":{"label":"Selected","value":{"$path":"amount"},"unit":"BNB"},"children":[]}}
{"op":"add","path":"/elements/addr-input","value":{"type":"Input","props":{"label":"Recipient Address","placeholder":"0x...","statePath":"address"},"children":[],"validation":{"checks":[{"fn":"required","message":"Address is required"}],"validateOn":"blur"}}}
{"op":"add","path":"/elements/send-btn","value":{"type":"Button","props":{"label":"Send BNB","variant":"primary"},"children":[],"on":{"press":{"action":"sendBnb","params":{"amount":{"$path":"amount"},"address":{"$path":"address"}},"confirm":{"title":"Confirm transfer","message":"Send BNB to this address?","confirmLabel":"Send","cancelLabel":"Cancel"}}}}}
{"op":"add","path":"/state/amount","value":0.1}
{"op":"add","path":"/state/address","value":""}
\`\`\`

---

User: "What does BNB stand for?"

Your response: BNB stands for Binance Coin — it's the native token of the BNB Chain (formerly Binance Smart Chain).

(text-only reply — no patches needed)`;

// ══════════════════════════════════════════════════════════════════════
// BACK-COMPAT ASSEMBLER
// ══════════════════════════════════════════════════════════════════════

export interface CatalogPromptOptions {
  /** Extra rules appended to the end of the prompt. */
  customRules?: string[];
  /** Include a small example UiSpec at the end. */
  includeExamples?: boolean;
  /** Only include these component types (subset of catalog). */
  componentFilter?: string[];
  /**
   * Output mode:
   *   "generate" (default) — AI outputs ONLY JSONL patches, no prose.
   *   "chat"               — AI responds conversationally first, then
   *                          emits JSONL patches on their own lines.
   */
  mode?: "generate" | "chat";
}

/**
 * Assembles the full UI catalog system prompt from the static blocks
 * and a rendered component catalog. Prefer composing the named exports
 * directly at the call site when you know which sections you need.
 */
export function generateCatalogPrompt(options?: CatalogPromptOptions): string {
  const mode = options?.mode ?? "generate";

  const parts: string[] = [
    mode === "chat" ? UI_INSTRUCTION_HEADER_CHAT : UI_INSTRUCTION_HEADER_GENERATE,
    UI_PATCH_FORMAT,
    formatComponentCatalogForPrompt({ include: options?.componentFilter }),
    UI_BINDING_DOCS,
  ];

  if (options?.customRules && options.customRules.length > 0) {
    parts.push(
      `## Additional rules\n\n${options.customRules.map((r) => `- ${r}`).join("\n")}`,
    );
  }

  if (options?.includeExamples) {
    parts.push(mode === "chat" ? UI_EXAMPLE_CHAT : UI_EXAMPLE_GENERATE);
  }

  return parts.join("\n\n");
}
