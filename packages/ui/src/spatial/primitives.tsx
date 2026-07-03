/**
 * Spatial primitive vocabulary — the components a view is authored with, once.
 *
 * Each primitive is a branded React component. It serves two consumers from a
 * single source of truth (the `build*Spec` mappers):
 *
 *  1. **DOM (GUI/XR)** — the component renders real DOM via {@link renderDomNode}.
 *  2. **IR (TUI)**     — the evaluator (`evaluate.ts`) recognises the brand,
 *                        calls the same `build*Spec`, and recurses into children
 *                        to assemble a {@link SpatialNode} tree.
 *
 * Because both paths derive from the same spec mapper, GUI/XR and TUI can never
 * drift: there is exactly one definition of what a `<Stack gap={2}>` *is*.
 *
 * Authoring sugar (`HStack`, `VStack`, `Card`, `List`) compiles to the same
 * `box` node — there is one container primitive underneath.
 */

import type { CSSProperties, ReactNode } from "react";
import { useSpatialContext } from "./context.ts";
import type {
  SpatialAgentMeta,
  SpatialAlign,
  SpatialBorder,
  SpatialBoxNode,
  SpatialButtonNode,
  SpatialDirection,
  SpatialDividerNode,
  SpatialFieldNode,
  SpatialImageNode,
  SpatialJustify,
  SpatialLength,
  SpatialModality,
  SpatialPadding,
  SpatialSpacerNode,
  SpatialTextNode,
  SpatialTextStyle,
  SpatialTone,
} from "./ir.ts";
import { resolvePadding } from "./ir.ts";

/** Brand key carried on a primitive's component function. */
export const SPATIAL_KIND = Symbol.for("elizaos.spatial.kind");

export type SpatialKind =
  | "box"
  | "text"
  | "button"
  | "field"
  | "divider"
  | "spacer"
  | "image"
  | "escape";

type Branded<P> = ((props: P) => ReactNode) & { [SPATIAL_KIND]: SpatialKind };

/** Read the spatial kind off a component type, or null if it isn't a primitive. */
export function getSpatialKind(type: unknown): SpatialKind | null {
  if (typeof type !== "function") return null;
  const kind = (type as { [SPATIAL_KIND]?: SpatialKind })[SPATIAL_KIND];
  return kind ?? null;
}

function brand<P>(
  kind: SpatialKind,
  component: (props: P) => ReactNode,
): Branded<P> {
  const branded = component as Branded<P>;
  branded[SPATIAL_KIND] = kind;
  return branded;
}

// --- Authoring prop types ---------------------------------------------------

interface CommonProps {
  grow?: number;
  shrink?: number;
  width?: SpatialLength;
  height?: SpatialLength;
  /** Agent-surface id; or a full meta object. Lets the agent drive the node. */
  agent?: string | SpatialAgentMeta;
}

export interface StackProps extends CommonProps {
  direction?: SpatialDirection;
  gap?: number;
  padding?: SpatialPadding;
  align?: SpatialAlign;
  justify?: SpatialJustify;
  wrap?: boolean;
  border?: SpatialBorder | boolean;
  title?: string;
  tone?: SpatialTone;
  children?: ReactNode;
}

export interface TextProps extends CommonProps {
  style?: SpatialTextStyle;
  tone?: SpatialTone;
  bold?: boolean;
  dim?: boolean;
  align?: "start" | "center" | "end";
  wrap?: boolean;
  children?: ReactNode;
}

export interface ButtonProps extends CommonProps {
  tone?: SpatialTone;
  disabled?: boolean;
  variant?: "solid" | "outline" | "ghost";
  onPress?: () => void;
  children?: ReactNode;
}

export interface FieldProps extends CommonProps {
  label?: string;
  value?: string;
  placeholder?: string;
  kind?: "text" | "number" | "password" | "textarea" | "select";
  options?: string[];
  disabled?: boolean;
  onChange?: (value: string) => void;
}

export interface DividerProps extends CommonProps {
  orientation?: "horizontal" | "vertical";
  label?: string;
}

export interface SpacerProps extends CommonProps {
  size?: number;
}

export interface ImageProps extends CommonProps {
  src: string;
  alt?: string;
}

/**
 * The DOM-escape hatch: render arbitrary real DOM (canvas / WebGL / 3D / charts /
 * `<audio>`) in GUI/XR, with a spatial-primitive fallback for TUI.
 *
 * In GUI/XR the {@link Escape} component renders `children` as real DOM inside a
 * growing flex box. In TUI the evaluator never renders the DOM children (they
 * can't run in a terminal) — it emits the evaluated `tui` fallback instead, or a
 * placeholder when none is given.
 */
export interface EscapeProps extends CommonProps {
  /** The real DOM/canvas content rendered in GUI/XR. */
  children?: ReactNode;
  /** Spatial-primitive fallback rendered in TUI. */
  tui?: ReactNode;
}

function normalizeAgent(
  agent: string | SpatialAgentMeta | undefined,
): SpatialAgentMeta | undefined {
  if (agent === undefined) return undefined;
  return typeof agent === "string" ? { id: agent } : agent;
}

function normalizeBorder(
  border: SpatialBorder | boolean | undefined,
): SpatialBorder | undefined {
  if (border === undefined) return undefined;
  if (border === true) return "single";
  if (border === false) return "none";
  return border;
}

// --- Spec builders (single source of truth, no children) --------------------

export function buildBoxSpec(
  props: StackProps,
): Omit<SpatialBoxNode, "children"> {
  return {
    type: "box",
    direction: props.direction ?? "column",
    gap: props.gap ?? 0,
    padding: props.padding,
    align: props.align,
    justify: props.justify,
    wrap: props.wrap,
    border: normalizeBorder(props.border),
    title: props.title,
    tone: props.tone,
    grow: props.grow,
    shrink: props.shrink,
    width: props.width,
    height: props.height,
    agent: normalizeAgent(props.agent),
  };
}

export function buildTextSpec(
  props: TextProps,
  value: string,
): SpatialTextNode {
  return {
    type: "text",
    value,
    style: props.style,
    tone: props.tone,
    bold: props.bold,
    dim: props.dim,
    align: props.align,
    wrap: props.wrap,
    grow: props.grow,
    shrink: props.shrink,
    width: props.width,
    height: props.height,
    agent: normalizeAgent(props.agent),
  };
}

export function buildButtonSpec(
  props: ButtonProps,
  label: string,
): SpatialButtonNode {
  return {
    type: "button",
    label,
    tone: props.tone,
    disabled: props.disabled,
    variant: props.variant,
    grow: props.grow,
    shrink: props.shrink,
    width: props.width,
    height: props.height,
    agent: normalizeAgent(props.agent) ?? {
      id: `btn:${label}`,
      role: "button",
      label,
    },
  };
}

export function buildFieldSpec(props: FieldProps): SpatialFieldNode {
  return {
    type: "field",
    label: props.label,
    value: props.value,
    placeholder: props.placeholder,
    kind: props.kind ?? "text",
    options: props.options,
    disabled: props.disabled,
    grow: props.grow,
    shrink: props.shrink,
    width: props.width,
    height: props.height,
    agent:
      normalizeAgent(props.agent) ??
      (props.label
        ? {
            id: `field:${props.label}`,
            role: "text-input",
            label: props.label,
            value: props.value ?? "",
          }
        : undefined),
  };
}

export function buildDividerSpec(props: DividerProps): SpatialDividerNode {
  return {
    type: "divider",
    orientation: props.orientation ?? "horizontal",
    label: props.label,
    grow: props.grow,
    width: props.width,
    height: props.height,
  };
}

export function buildSpacerSpec(props: SpacerProps): SpatialSpacerNode {
  return {
    type: "spacer",
    size: props.size,
    grow: props.grow,
    width: props.width,
    height: props.height,
  };
}

export function buildImageSpec(props: ImageProps): SpatialImageNode {
  return {
    type: "image",
    src: props.src,
    alt: props.alt,
    grow: props.grow,
    shrink: props.shrink,
    width: props.width,
    height: props.height,
    agent: normalizeAgent(props.agent),
  };
}

/** Flatten a ReactNode's text content (for `<Text>`/`<Button>` leaf labels). */
export function flattenText(children: ReactNode): string {
  if (
    children === null ||
    children === undefined ||
    children === false ||
    children === true
  ) {
    return "";
  }
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(flattenText).join("");
  // A nested element used as text content: best-effort read of its children.
  if (typeof children === "object" && "props" in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    return flattenText(props?.children);
  }
  return "";
}

// --- DOM rendering (GUI/XR) -------------------------------------------------

/** Cell → rem multiplier per modality. XR scales up for headset legibility. */
const CELL_REM: Record<SpatialModality, number> = {
  gui: 0.25,
  tui: 0.25,
  xr: 0.34,
};

const TEXT_REM: Record<SpatialTextStyle, number> = {
  heading: 1.5,
  subheading: 1.15,
  body: 1,
  caption: 0.85,
  label: 0.8,
};

function toneColor(tone: SpatialTone | undefined): string | undefined {
  switch (tone) {
    case "primary":
      return "var(--primary, #d2691e)";
    case "muted":
      return "var(--muted-foreground, #8a8a8a)";
    case "success":
      return "var(--success, #3aa657)";
    case "warning":
      return "var(--warning, #c98a00)";
    case "danger":
      return "var(--destructive, #d23f3f)";
    default:
      return undefined;
  }
}

function toneSurface(tone: SpatialTone | undefined): string | undefined {
  if (!tone || tone === "default") return undefined;
  const color = toneColor(tone);
  return color ? `color-mix(in srgb, ${color} 12%, transparent)` : undefined;
}

function lengthToCss(
  value: SpatialLength | undefined,
  cell: number,
): string | undefined {
  if (value === undefined || value === "auto") return undefined;
  if (typeof value === "number") return `${value * cell}rem`;
  return value; // percentage string
}

function paddingToCss(
  padding: SpatialPadding | undefined,
  cell: number,
): string | undefined {
  if (padding === undefined) return undefined;
  const p = resolvePadding(padding);
  return `${p.top * cell}rem ${p.right * cell}rem ${p.bottom * cell}rem ${p.left * cell}rem`;
}

const ALIGN_CSS: Record<SpatialAlign, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};

const JUSTIFY_CSS: Record<SpatialJustify, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
};

function agentDataProps(
  agent: SpatialAgentMeta | undefined,
): Record<string, string> {
  if (!agent) return {};
  const out: Record<string, string> = { "data-agent-id": agent.id };
  if (agent.role) out["data-agent-role"] = agent.role;
  if (agent.label) out["data-agent-label"] = agent.label;
  return out;
}

function commonFlexStyle(
  node: {
    grow?: number;
    shrink?: number;
    width?: SpatialLength;
    height?: SpatialLength;
  },
  cell: number,
): CSSProperties {
  const style: CSSProperties = {};
  if (node.grow !== undefined) style.flexGrow = node.grow;
  if (node.shrink !== undefined) style.flexShrink = node.shrink;
  const width = lengthToCss(node.width, cell);
  const height = lengthToCss(node.height, cell);
  if (width) style.width = width;
  if (height) style.height = height;
  if (node.width !== undefined && node.width !== "auto")
    style.flexShrink = node.shrink ?? 0;
  return style;
}

const BORDER_CSS: Record<SpatialBorder, string | undefined> = {
  none: undefined,
  single: "1px solid var(--border, rgba(128,128,128,0.35))",
  round: "1px solid var(--border, rgba(128,128,128,0.35))",
  double: "3px double var(--border, rgba(128,128,128,0.5))",
};

export const Stack = brand<StackProps>("box", function Stack(props) {
  const { modality } = useSpatialContext();
  const cell = CELL_REM[modality];
  const spec = buildBoxSpec(props);
  const style: CSSProperties = {
    display: "flex",
    flexDirection: spec.direction === "row" ? "row" : "column",
    gap: `${spec.gap * cell}rem`,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: 0,
    ...commonFlexStyle(spec, cell),
  };
  if (spec.padding) style.padding = paddingToCss(spec.padding, cell);
  if (spec.align) style.alignItems = ALIGN_CSS[spec.align];
  if (spec.justify) style.justifyContent = JUSTIFY_CSS[spec.justify];
  if (spec.wrap) style.flexWrap = "wrap";
  if (spec.border && spec.border !== "none") {
    style.border = BORDER_CSS[spec.border];
    style.borderRadius = spec.border === "round" ? "0.5rem" : undefined;
  }
  const surface = toneSurface(spec.tone);
  if (surface) style.background = surface;
  return (
    <div data-spatial-kind="box" style={style} {...agentDataProps(spec.agent)}>
      {spec.title ? (
        <div
          data-spatial-kind="title"
          style={{
            fontSize: `${TEXT_REM.label * cell * 4}rem`,
            fontWeight: 600,
            opacity: 0.8,
            color: toneColor(spec.tone),
          }}
        >
          {spec.title}
        </div>
      ) : null}
      {props.children}
    </div>
  );
});

export const Text = brand<TextProps>("text", function Text(props) {
  const { modality } = useSpatialContext();
  const cell = CELL_REM[modality];
  const value = flattenText(props.children);
  const spec = buildTextSpec(props, value);
  const style: SpatialTextStyle = spec.style ?? "body";
  const css: CSSProperties = {
    fontSize: `${TEXT_REM[style] * (modality === "xr" ? 1.25 : 1)}rem`,
    fontWeight:
      spec.bold || style === "heading" || style === "subheading" ? 600 : 400,
    opacity: spec.dim ? 0.6 : 1,
    color: toneColor(spec.tone),
    textAlign: spec.align ?? undefined,
    whiteSpace: spec.wrap === false ? "nowrap" : "normal",
    overflow: spec.wrap === false ? "hidden" : undefined,
    textOverflow: spec.wrap === false ? "ellipsis" : undefined,
    margin: 0,
    minWidth: 0,
    ...commonFlexStyle(spec, cell),
  };
  return (
    <span data-spatial-kind="text" style={css} {...agentDataProps(spec.agent)}>
      {value}
    </span>
  );
});

export const Button = brand<ButtonProps>("button", function Button(props) {
  const { modality, dispatch } = useSpatialContext();
  const cell = CELL_REM[modality];
  const label = flattenText(props.children);
  const spec = buildButtonSpec(props, label);
  const variant = spec.variant ?? "solid";
  const tone = spec.tone ?? "primary";
  const color = toneColor(tone) ?? "var(--primary, #d2691e)";
  const css: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5em",
    minHeight: "44px",
    minWidth: "44px",
    padding: modality === "xr" ? "0.6rem 1.1rem" : "0.4rem 0.8rem",
    borderRadius: "0.4rem",
    fontWeight: 600,
    fontSize: modality === "xr" ? "1.15rem" : "0.9rem",
    cursor: spec.disabled ? "not-allowed" : "pointer",
    opacity: spec.disabled ? 0.5 : 1,
    border:
      variant === "ghost" ? "1px solid transparent" : `1px solid ${color}`,
    background: variant === "solid" ? color : "transparent",
    color: variant === "solid" ? "var(--primary-foreground, #fff)" : color,
    ...commonFlexStyle(spec, cell),
  };
  return (
    <button
      type="button"
      data-spatial-kind="button"
      disabled={spec.disabled}
      style={css}
      onClick={() => {
        if (spec.disabled) return;
        props.onPress?.();
        if (spec.agent?.id)
          dispatch?.({ type: "press", agentId: spec.agent.id });
      }}
      {...agentDataProps(spec.agent)}
    >
      {label}
    </button>
  );
});

export const Field = brand<FieldProps>("field", function Field(props) {
  const { modality } = useSpatialContext();
  const cell = CELL_REM[modality];
  const spec = buildFieldSpec(props);
  const labelCss: CSSProperties = {
    fontSize: "0.75rem",
    fontWeight: 600,
    opacity: 0.7,
    marginBottom: "0.25rem",
  };
  const inputCss: CSSProperties = {
    padding: "0.4rem 0.6rem",
    borderRadius: "0.4rem",
    border: "1px solid var(--border, rgba(128,128,128,0.35))",
    background: "var(--background, transparent)",
    color: "inherit",
    fontSize: modality === "xr" ? "1.1rem" : "0.9rem",
    width: "100%",
    boxSizing: "border-box",
  };
  const wrap: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    ...commonFlexStyle(spec, cell),
  };
  // A div (not a <label>): the control is rendered conditionally, so static a11y
  // association can't see it; the field is addressable via its agent metadata.
  return (
    <div data-spatial-kind="field" style={wrap}>
      {spec.label ? <span style={labelCss}>{spec.label}</span> : null}
      {spec.kind === "textarea" ? (
        <textarea
          style={inputCss}
          placeholder={spec.placeholder}
          defaultValue={spec.value}
          disabled={spec.disabled}
          onChange={(e) => props.onChange?.(e.target.value)}
          {...agentDataProps(spec.agent)}
        />
      ) : spec.kind === "select" ? (
        <select
          style={inputCss}
          defaultValue={spec.value}
          disabled={spec.disabled}
          onChange={(e) => props.onChange?.(e.target.value)}
          {...agentDataProps(spec.agent)}
        >
          {(spec.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={
            spec.kind === "password"
              ? "password"
              : spec.kind === "number"
                ? "number"
                : "text"
          }
          style={inputCss}
          placeholder={spec.placeholder}
          defaultValue={spec.value}
          disabled={spec.disabled}
          onChange={(e) => props.onChange?.(e.target.value)}
          {...agentDataProps(spec.agent)}
        />
      )}
    </div>
  );
});

export const Divider = brand<DividerProps>("divider", function Divider(props) {
  const spec = buildDividerSpec(props);
  if (spec.orientation === "vertical") {
    return (
      <div
        aria-hidden="true"
        data-spatial-kind="divider"
        style={{
          width: 1,
          alignSelf: "stretch",
          background: "var(--border, rgba(128,128,128,0.35))",
        }}
      />
    );
  }
  // A labeled divider is a section header: the caption is meaningful content,
  // so render it (not aria-hidden) between two decorative rules. The plain rule
  // stays decorative/aria-hidden. (Restores rendering #9486 collapsed away.)
  if (spec.label) {
    return (
      <div
        data-spatial-kind="divider"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          opacity: 0.7,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            flex: 1,
            height: 1,
            background: "var(--border, rgba(128,128,128,0.35))",
          }}
        />
        <span style={{ fontSize: "0.75rem" }}>{spec.label}</span>
        <div
          aria-hidden="true"
          style={{
            flex: 1,
            height: 1,
            background: "var(--border, rgba(128,128,128,0.35))",
          }}
        />
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      data-spatial-kind="divider"
      style={{
        height: 1,
        alignSelf: "stretch",
        background: "var(--border, rgba(128,128,128,0.35))",
      }}
    />
  );
});

export const Spacer = brand<SpacerProps>("spacer", function Spacer(props) {
  const { modality } = useSpatialContext();
  const cell = CELL_REM[modality];
  const spec = buildSpacerSpec(props);
  const style: CSSProperties = {};
  if (spec.size !== undefined) {
    style.flex = `0 0 ${spec.size * cell}rem`;
  } else {
    style.flex = spec.grow ?? 1;
  }
  return <div data-spatial-kind="spacer" style={style} />;
});

export const Image = brand<ImageProps>("image", function Image(props) {
  const { modality } = useSpatialContext();
  const cell = CELL_REM[modality];
  const spec = buildImageSpec(props);
  return (
    <img
      data-spatial-kind="image"
      src={spec.src}
      alt={spec.alt ?? ""}
      style={{
        objectFit: "cover",
        borderRadius: "0.4rem",
        ...commonFlexStyle(spec, cell),
      }}
      {...agentDataProps(spec.agent)}
    />
  );
});

/**
 * DOM-escape primitive. In GUI/XR it renders its real DOM `children` inside a
 * growing flex box so a `<canvas>`/WebGL/3D/chart surface can size to it. In TUI
 * it is never rendered — `evaluate.ts` intercepts the `escape` kind and emits the
 * `tui` fallback instead (the DOM children can't run in a terminal).
 *
 * The box defaults to `grow: 1` and `minHeight: 0` so a canvas styled
 * `width:100%; height:100%` (or `flex:1`) fills the available space.
 */
export const Escape = brand<EscapeProps>("escape", function Escape(props) {
  const { modality } = useSpatialContext();
  const cell = CELL_REM[modality];
  const agent = normalizeAgent(props.agent);
  const style: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: 0,
    ...commonFlexStyle(
      {
        grow: props.grow ?? 1,
        shrink: props.shrink,
        width: props.width,
        height: props.height,
      },
      cell,
    ),
  };
  return (
    <div data-spatial-kind="escape" style={style} {...agentDataProps(agent)}>
      {props.children}
    </div>
  );
});

// --- Authoring sugar (all compile to `box`) ---------------------------------

export function HStack(props: Omit<StackProps, "direction">) {
  return <Stack {...props} direction="row" />;
}
export function VStack(props: Omit<StackProps, "direction">) {
  return <Stack {...props} direction="column" />;
}
/** A compact grouped surface without a visible frame by default. */
export function Card({
  border,
  gap,
  padding,
  title: _title,
  ...props
}: StackProps) {
  return (
    <Stack
      {...props}
      border={border ?? "none"}
      padding={padding ?? 1}
      gap={gap ?? 1}
    />
  );
}
/** A vertical list with a default gap. */
export function List(props: Omit<StackProps, "direction">) {
  return <Stack {...props} direction="column" gap={props.gap ?? 1} />;
}
