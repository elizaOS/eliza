/**
 * Spatial layout IR — the modality-agnostic node tree.
 *
 * A view is authored once with the spatial primitives (`primitives.tsx`). When
 * rendered it produces a tree of {@link SpatialNode}s: pure, serialisable data
 * with no React and no DOM. Every renderer consumes the SAME tree:
 *
 *  - **GUI** (`dom.tsx`)        → DOM via flexbox CSS.
 *  - **XR**  (`dom.tsx` + ctx)  → the same DOM, with spatially-scaled sizing.
 *  - **TUI** (`tui/`)           → terminal lines via a flexbox layout pass.
 *
 * The IR is the single contract that keeps the three modalities in parity: a
 * box is a flex container in all three, a `gap` of 2 means the same logical
 * spacing everywhere, `grow` distributes free space identically. Renderers only
 * differ in the *unit* a cell maps to (a CSS rem vs. a terminal column).
 *
 * Keep this file free of React/DOM imports so it can be unit-tested and shared
 * by the Node-side terminal renderer without dragging in a browser graph.
 */

/** Presentation modality of the surface a spatial view renders into. */
export type SpatialModality = "gui" | "tui" | "xr";

/** Flex main axis for a container. */
export type SpatialDirection = "row" | "column";

/** Cross-axis alignment of children within a container. */
export type SpatialAlign = "start" | "center" | "end" | "stretch";

/** Main-axis distribution of children within a container. */
export type SpatialJustify = "start" | "center" | "end" | "between" | "around";

/** Semantic tone, mapped to colours (GUI/XR) and ANSI styling (TUI). */
export type SpatialTone =
  | "default"
  | "muted"
  | "primary"
  | "success"
  | "warning"
  | "danger";

/** Text role; drives size/weight in GUI/XR and weight/underline in TUI. */
export type SpatialTextStyle =
  | "heading"
  | "subheading"
  | "body"
  | "caption"
  | "label";

/** Border treatment for a box. */
export type SpatialBorder = "none" | "single" | "round" | "double";

/**
 * A length along one axis.
 *
 *  - `number`       — logical cells. GUI/XR multiply by a per-modality cell
 *                     size (rem); TUI treats it as literal terminal columns/rows.
 *  - `"auto"`       — size to content (the default).
 *  - `` `${n}%` ``  — percentage of the parent's inner size. Honoured by GUI/XR;
 *                     the TUI engine resolves it against the parent content box.
 */
export type SpatialLength = number | "auto" | `${number}%`;

/** Padding: one value (all sides), `[vertical, horizontal]`, or per-side. */
export type SpatialPadding =
  | number
  | [vertical: number, horizontal: number]
  | { top?: number; right?: number; bottom?: number; left?: number };

/** Agent-surface metadata so the agent can introspect/drive a node uniformly. */
export interface SpatialAgentMeta {
  /** Stable id addressable via the view-interact protocol. */
  id: string;
  /** Role hint (`button`, `text-input`, `list-item`, …). */
  role?: string;
  /** Human-readable label for the agent. */
  label?: string;
  /** Current value for inputs/toggles. */
  value?: string | number | boolean | null;
}

/** Fields shared by every layout participant. */
interface SpatialCommon {
  /** Stable key for diffing/order; mirrors a React key when present. */
  key?: string;
  /** flex-grow factor. 0 = size to content (default). */
  grow?: number;
  /** flex-shrink factor. Defaults to 1 (may shrink) for content, 0 for fixed. */
  shrink?: number;
  /** Explicit main-axis-independent width. */
  width?: SpatialLength;
  /** Explicit height. */
  height?: SpatialLength;
  /** Agent-surface metadata. */
  agent?: SpatialAgentMeta;
}

/** A flex container. The workhorse: Stack/HStack/VStack/Card/List compile here. */
export interface SpatialBoxNode extends SpatialCommon {
  type: "box";
  direction: SpatialDirection;
  gap: number;
  padding?: SpatialPadding;
  align?: SpatialAlign;
  justify?: SpatialJustify;
  wrap?: boolean;
  border?: SpatialBorder;
  /** Optional caption rendered into the top border / as a heading row. */
  title?: string;
  /** Surface tone (background tint in GUI/XR, border colour in TUI). */
  tone?: SpatialTone;
  children: SpatialNode[];
}

/** A run of text. Wraps within its content box in all modalities. */
export interface SpatialTextNode extends SpatialCommon {
  type: "text";
  value: string;
  style?: SpatialTextStyle;
  tone?: SpatialTone;
  /** Bold overrides the weight implied by `style`. */
  bold?: boolean;
  dim?: boolean;
  align?: "start" | "center" | "end";
  /** When false, the text is truncated with an ellipsis instead of wrapping. */
  wrap?: boolean;
}

/** An actionable button. */
export interface SpatialButtonNode extends SpatialCommon {
  type: "button";
  label: string;
  tone?: SpatialTone;
  disabled?: boolean;
  /** Visual emphasis: solid fill vs. outline vs. text-only. */
  variant?: "solid" | "outline" | "ghost";
}

/** A labelled input rendered as a display affordance across modalities. */
export interface SpatialFieldNode extends SpatialCommon {
  type: "field";
  label?: string;
  value?: string;
  placeholder?: string;
  kind?: "text" | "number" | "password" | "textarea" | "select";
  /** Options for `kind: "select"`. */
  options?: string[];
  disabled?: boolean;
}

/** A rule separating content. */
export interface SpatialDividerNode extends SpatialCommon {
  type: "divider";
  orientation?: "horizontal" | "vertical";
  /** Optional inline caption centred on the rule. */
  label?: string;
}

/** Flexible or fixed empty space. */
export interface SpatialSpacerNode extends SpatialCommon {
  type: "spacer";
  /** Fixed size in cells; omit and set `grow` for a flexible spacer. */
  size?: number;
}

/** An image. Rendered as a real `<img>` in GUI/XR, alt/placeholder in TUI. */
export interface SpatialImageNode extends SpatialCommon {
  type: "image";
  src: string;
  alt?: string;
}

/** The discriminated union of every spatial node. */
export type SpatialNode =
  | SpatialBoxNode
  | SpatialTextNode
  | SpatialButtonNode
  | SpatialFieldNode
  | SpatialDividerNode
  | SpatialSpacerNode
  | SpatialImageNode;

/** A node that participates in flex layout as a container. */
export function isContainer(node: SpatialNode): node is SpatialBoxNode {
  return node.type === "box";
}

/** Normalise {@link SpatialPadding} to explicit per-side cells. */
export function resolvePadding(padding: SpatialPadding | undefined): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === "number") {
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  if (Array.isArray(padding)) {
    const [v, h] = padding;
    return { top: v, right: h, bottom: v, left: h };
  }
  return {
    top: padding.top ?? 0,
    right: padding.right ?? 0,
    bottom: padding.bottom ?? 0,
    left: padding.left ?? 0,
  };
}
