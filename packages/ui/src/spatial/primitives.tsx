/**
 * Spatial primitive vocabulary — the components a view is authored with, once.
 *
 * Each primitive is a branded React component. It serves two consumers from a
 * single source of truth (the `build*Spec` mappers):
 *
 *  1. **DOM** — the component renders real DOM via {@link renderDomNode}.
 *  2. **IR**  — the evaluator (`evaluate.ts`) recognises the brand, calls the
 *               same `build*Spec`, and recurses into children to assemble a
 *               {@link SpatialNode} tree for future adapters.
 *
 * Because both paths derive from the same spec mapper, the shipped DOM renderer
 * and future adapters share exactly one definition of what a
 * `<Stack gap={2}>` *is*.
 *
 * Authoring sugar (`HStack`, `VStack`, `Card`, `List`) compiles to the same
 * `box` node — there is one container primitive underneath.
 */

import { type CSSProperties, type ReactNode, useId } from "react";
import { Badge as UiBadge } from "../components/ui/badge";
import { Button as UiButton } from "../components/ui/button";
import {
  Card as UiCard,
  CardTitle as UiCardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Separator as UiSeparator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
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
const EMPTY_SPATIAL_SELECT_VALUE = "__eliza_spatial_empty__";

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
  pressed?: boolean;
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
 * The DOM escape hatch: render arbitrary real DOM (canvas / WebGL / 3D / charts /
 * `<audio>`) in the shipped browser surface.
 *
 * {@link Escape} renders `children` as real DOM inside a growing flex box. The
 * IR evaluator treats this as non-portable content and emits a placeholder for
 * future adapters.
 */
export interface EscapeProps extends CommonProps {
  /** The real DOM/canvas content rendered in the browser surface. */
  children?: ReactNode;
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
    pressed: props.pressed,
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

// --- DOM rendering ----------------------------------------------------------

/** Cell → rem multiplier per retained modality. */
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
  if (agent.authority === "human") {
    return {
      "data-agent-authority": "human",
      "data-agent-human-id": agent.id,
    };
  }
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

function spatialToneBadgeTone(
  tone: SpatialTone | undefined,
): "default" | "accent" | "muted" | "success" | "warning" | "danger" {
  switch (tone) {
    case "primary":
      return "accent";
    case "muted":
      return "muted";
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "danger":
      return "danger";
    default:
      return "default";
  }
}

function SpatialBorderFrame({ border }: { border: SpatialBorder }) {
  if (border === "none") return null;
  return (
    <>
      <UiSeparator className="pointer-events-none absolute inset-x-0 top-0 z-10" />
      <UiSeparator className="pointer-events-none absolute inset-x-0 bottom-0 z-10" />
      <UiSeparator
        orientation="vertical"
        className="pointer-events-none absolute inset-y-0 left-0 z-10"
      />
      <UiSeparator
        orientation="vertical"
        className="pointer-events-none absolute inset-y-0 right-0 z-10"
      />
      {border === "double" ? (
        <>
          <UiSeparator className="pointer-events-none absolute inset-x-1 top-1 z-10" />
          <UiSeparator className="pointer-events-none absolute inset-x-1 bottom-1 z-10" />
          <UiSeparator
            orientation="vertical"
            className="pointer-events-none absolute inset-y-1 left-1 z-10"
          />
          <UiSeparator
            orientation="vertical"
            className="pointer-events-none absolute inset-y-1 right-1 z-10"
          />
        </>
      ) : null}
    </>
  );
}

export const Stack = brand<StackProps>("box", function Stack(props) {
  const { modality } = useSpatialContext();
  const cell = CELL_REM[modality];
  const spec = buildBoxSpec(props);
  const layoutStyle: CSSProperties = {
    display: "flex",
    flexDirection: props.direction === "row" ? "row" : "column",
    gap: `${(props.gap ?? 0) * cell}rem`,
    boxSizing: "border-box",
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    ...commonFlexStyle(props, cell),
  };
  if (props.padding) layoutStyle.padding = paddingToCss(props.padding, cell);
  if (props.align) layoutStyle.alignItems = ALIGN_CSS[props.align];
  if (props.justify) layoutStyle.justifyContent = JUSTIFY_CSS[props.justify];
  if (props.wrap) layoutStyle.flexWrap = "wrap";
  const border = normalizeBorder(props.border) ?? "none";
  return (
    <UiCard
      asChild
      variant={border === "round" ? "transparent" : "transparentSquare"}
    >
      <div
        data-spatial-kind="box"
        style={layoutStyle}
        {...agentDataProps(spec.agent)}
      >
        {spec.tone && spec.tone !== "default" ? (
          <UiBadge
            asChild
            variant="visualAnchor"
            tone={spatialToneBadgeTone(spec.tone)}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
            />
          </UiBadge>
        ) : null}
        <SpatialBorderFrame border={border} />
        {spec.title ? (
          <UiCardTitle
            data-spatial-kind="title"
            style={{
              fontSize: `${TEXT_REM.label * cell * 4}rem`,
              fontWeight: 600,
              opacity: 0.8,
            }}
          >
            {spec.title}
          </UiCardTitle>
        ) : null}
        {props.children}
      </div>
    </UiCard>
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
  const layoutStyle: CSSProperties = {
    minHeight: "44px",
    minWidth: "44px",
    padding: modality === "xr" ? "0.6rem 1.1rem" : "0.4rem 0.8rem",
    fontWeight: 600,
    fontSize: modality === "xr" ? "1.15rem" : "0.9rem",
    opacity: spec.disabled ? 0.5 : 1,
    ...commonFlexStyle(spec, cell),
  };
  return (
    <UiButton
      variant={
        variant === "solid"
          ? "default"
          : variant === "outline"
            ? "outline"
            : "ghost"
      }
      size="touch"
      data-spatial-kind="button"
      disabled={spec.disabled}
      aria-label={spec.agent?.label}
      aria-pressed={spec.pressed}
      style={layoutStyle}
      visualStyle={{
        backgroundColor: variant === "solid" ? color : "transparent",
        borderColor: variant === "ghost" ? "transparent" : color,
        color: variant === "solid" ? "var(--primary-foreground, #fff)" : color,
      }}
      onClick={() => {
        if (spec.disabled) return;
        props.onPress?.();
        if (spec.agent?.id)
          dispatch?.({ type: "press", agentId: spec.agent.id });
      }}
      {...agentDataProps(spec.agent)}
    >
      {label}
    </UiButton>
  );
});

export const Field = brand<FieldProps>("field", function Field(props) {
  const { modality } = useSpatialContext();
  const fieldId = useId();
  const cell = CELL_REM[modality];
  const spec = buildFieldSpec(props);
  const labelCss: CSSProperties = {
    fontSize: "0.75rem",
    fontWeight: 600,
    opacity: 0.7,
    marginBottom: "0.25rem",
  };
  const fieldTextStyle: CSSProperties = {
    fontSize: modality === "xr" ? "1.1rem" : "0.9rem",
  };
  const wrap: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    ...commonFlexStyle(spec, cell),
  };
  return (
    <div data-spatial-kind="field" style={wrap}>
      {spec.label ? (
        <label htmlFor={fieldId} style={labelCss}>
          {spec.label}
        </label>
      ) : null}
      {spec.kind === "textarea" ? (
        <Textarea
          variant="default"
          id={fieldId}
          aria-label={spec.label ?? spec.agent?.label}
          style={fieldTextStyle}
          placeholder={spec.placeholder}
          defaultValue={spec.value}
          disabled={spec.disabled}
          onChange={(e) => props.onChange?.(e.target.value)}
          {...agentDataProps(spec.agent)}
        />
      ) : spec.kind === "select" ? (
        <Select
          defaultValue={
            spec.value === "" ? EMPTY_SPATIAL_SELECT_VALUE : spec.value
          }
          disabled={spec.disabled}
          onValueChange={(value) =>
            props.onChange?.(value === EMPTY_SPATIAL_SELECT_VALUE ? "" : value)
          }
        >
          <SelectTrigger
            variant="default"
            id={fieldId}
            aria-label={spec.label ?? spec.agent?.label}
            style={fieldTextStyle}
            {...agentDataProps(spec.agent)}
          >
            <SelectValue placeholder={spec.placeholder ?? ""} />
          </SelectTrigger>
          <SelectContent>
            {(spec.options ?? []).map((opt) => (
              <SelectItem
                key={opt}
                value={opt === "" ? EMPTY_SPATIAL_SELECT_VALUE : opt}
              >
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          variant="default"
          id={fieldId}
          aria-label={spec.label ?? spec.agent?.label}
          type={
            spec.kind === "password"
              ? "password"
              : spec.kind === "number"
                ? "number"
                : "text"
          }
          style={fieldTextStyle}
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
      <UiSeparator
        orientation="vertical"
        aria-hidden="true"
        data-spatial-kind="divider"
        layoutStyle={{ alignSelf: "stretch", height: "auto" }}
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
        <UiSeparator
          aria-hidden="true"
          layoutStyle={{ flex: 1, width: "auto" }}
        />
        <span style={{ fontSize: "0.75rem" }}>{spec.label}</span>
        <UiSeparator
          aria-hidden="true"
          layoutStyle={{ flex: 1, width: "auto" }}
        />
      </div>
    );
  }
  return <UiSeparator aria-hidden="true" data-spatial-kind="divider" />;
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
 * DOM-escape primitive. It renders its real DOM `children` inside a growing flex
 * box so a `<canvas>`/WebGL/3D/chart surface can size to it. The IR evaluator
 * intercepts the `escape` kind and emits a placeholder because the DOM children
 * are intentionally host-specific.
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
