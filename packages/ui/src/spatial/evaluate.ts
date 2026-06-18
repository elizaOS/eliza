/**
 * React → IR evaluator.
 *
 * GUI and XR render the authored React tree directly to DOM. The terminal can't
 * — there is no DOM in a terminal. This module is the bridge: it evaluates a
 * React element tree composed of the spatial primitives (plus plain function
 * components, fragments, arrays and conditionals) into the modality-agnostic
 * {@link SpatialNode} tree that the TUI layout engine consumes.
 *
 * It is a *snapshot* evaluator: it renders one frame. Effects don't run; that's
 * exactly right for producing a terminal frame. Interactive state works through
 * the framework hooks ({@link useSpatialState}, {@link useSpatialMemo},
 * {@link useSpatialRef}), which are backed here by a persistent {@link SpatialStateStore}
 * the terminal host holds across frames — and which delegate to React's own
 * hooks when the same component renders on a DOM surface. One component, both
 * paths, no branching in the view.
 *
 * Authoring constraint for cross-terminal views: use the `useSpatial*` hooks for
 * state, not React's `useState`/`useEffect`/`useContext` — the latter only run on
 * the DOM surface. Presentational components (props in, primitives out) need no
 * hooks at all and always work everywhere.
 */

import {
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useMemo as reactUseMemo,
  useRef as reactUseRef,
  useState as reactUseState,
} from "react";
import type { SpatialNode } from "./ir.ts";
import {
  buildBoxSpec,
  buildButtonSpec,
  buildDividerSpec,
  buildFieldSpec,
  buildImageSpec,
  buildSpacerSpec,
  buildTextSpec,
  flattenText,
  getSpatialKind,
} from "./primitives.tsx";

/** Persistent state for `useSpatial*` hooks, held by the host across frames. */
export interface SpatialStateStore {
  has(key: string): boolean;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** A plain Map-backed store. */
export function createSpatialStateStore(): SpatialStateStore {
  const map = new Map<string, unknown>();
  return {
    has: (k) => map.has(k),
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
  };
}

interface EvalFrame {
  path: string;
  hookIndex: number;
  store: SpatialStateStore | null;
  requestRender: (() => void) | null;
}

/** Set only while a function component is being evaluated into IR. */
let currentFrame: EvalFrame | null = null;

export interface EvaluateOptions {
  /** Persistent hook state across frames (omit for a stateless snapshot). */
  store?: SpatialStateStore;
  /** Called by a `useSpatialState` setter so the host can re-snapshot. */
  requestRender?: () => void;
  /**
   * When provided, button `onPress` handlers are recorded here keyed by the
   * button's agent id — so a terminal host can activate a focused button by
   * firing its handler (the IR itself carries no handlers). Cleared/owned by
   * the caller.
   */
  handlers?: Map<string, () => void>;
}

interface EvalContext {
  path: string;
  store: SpatialStateStore | null;
  requestRender: (() => void) | null;
  handlers: Map<string, () => void> | null;
}

/**
 * Evaluate a React element into a {@link SpatialNode} tree.
 *
 * Returns a single root node. A fragment/array root is wrapped in a column box
 * so callers always receive one node to lay out.
 */
export function evaluateToSpatialTree(
  element: ReactNode,
  options: EvaluateOptions = {},
): SpatialNode {
  const ctx: EvalContext = {
    path: "",
    store: options.store ?? null,
    requestRender: options.requestRender ?? null,
    handlers: options.handlers ?? null,
  };
  const nodes = evalNode(element, ctx, 0);
  if (nodes.length === 1) return nodes[0];
  return {
    type: "box",
    direction: "column",
    gap: 0,
    children: nodes,
  };
}

function evalChildren(children: ReactNode, ctx: EvalContext): SpatialNode[] {
  const out: SpatialNode[] = [];
  const list = Array.isArray(children) ? children : [children];
  let index = 0;
  for (const child of list) {
    if (Array.isArray(child)) {
      // Nested arrays (e.g. `.map()` inside a list): keep flattening.
      out.push(...evalChildren(child, ctx));
      index += 1;
      continue;
    }
    out.push(...evalNode(child, ctx, index));
    index += 1;
  }
  return out;
}

function unwrapComponentType(
  type: unknown,
): ((props: Record<string, unknown>) => ReactNode) | null {
  if (typeof type === "function") {
    return type as (props: Record<string, unknown>) => ReactNode;
  }
  // memo()/forwardRef() wrappers expose the real component on `.type`/`.render`.
  if (type && typeof type === "object") {
    const obj = type as { type?: unknown; render?: unknown };
    if (typeof obj.type === "function") {
      return obj.type as (props: Record<string, unknown>) => ReactNode;
    }
    if (typeof obj.render === "function") {
      return obj.render as (props: Record<string, unknown>) => ReactNode;
    }
  }
  return null;
}

function evalNode(
  node: ReactNode,
  ctx: EvalContext,
  indexHint: number,
): SpatialNode[] {
  if (node === null || node === undefined || node === false || node === true) {
    return [];
  }
  if (typeof node === "string") {
    const trimmed = node.trim();
    return trimmed.length === 0 ? [] : [{ type: "text", value: node }];
  }
  if (typeof node === "number") {
    return [{ type: "text", value: String(node) }];
  }
  if (Array.isArray(node)) {
    return evalChildren(node, ctx);
  }
  if (!isValidElement(node)) {
    return [];
  }

  const element = node as ReactElement<Record<string, unknown>>;
  const type = element.type;
  const props = (element.props ?? {}) as Record<string, unknown>;

  // Fragment: transparent — evaluate its children inline.
  if (type === Fragment) {
    return evalChildren(props.children as ReactNode, ctx);
  }

  // A branded spatial primitive: build its spec directly from props.
  const kind = getSpatialKind(type);
  if (kind) {
    const built = buildPrimitiveNode(kind, props, ctx);
    if (element.key != null) built.key = String(element.key);
    return [built];
  }

  // A function component (incl. memo/forwardRef and the HStack/VStack/Card sugar).
  const component = unwrapComponentType(type);
  if (component) {
    const name =
      (component as { displayName?: string; name?: string }).displayName ||
      (component as { name?: string }).name ||
      "anon";
    const childPath = `${ctx.path}/${name}#${indexHint}`;
    const frame: EvalFrame = {
      path: childPath,
      hookIndex: 0,
      store: ctx.store,
      requestRender: ctx.requestRender,
    };
    const previous = currentFrame;
    currentFrame = frame;
    let rendered: ReactNode;
    try {
      rendered = component(props);
    } finally {
      currentFrame = previous;
    }
    return evalNode(rendered, { ...ctx, path: childPath }, 0);
  }

  // Unknown host element (a raw <div> etc.): degrade to its children so text
  // still flows. Raw DOM has no terminal layout; views should use primitives.
  return evalChildren(props.children as ReactNode, ctx);
}

function buildPrimitiveNode(
  kind: ReturnType<typeof getSpatialKind> & string,
  props: Record<string, unknown>,
  ctx: EvalContext,
): SpatialNode {
  switch (kind) {
    case "box": {
      const spec = buildBoxSpec(props as never);
      return {
        ...spec,
        children: evalChildren(props.children as ReactNode, ctx),
      };
    }
    case "text":
      return buildTextSpec(
        props as never,
        flattenText(props.children as ReactNode),
      );
    case "button": {
      const node = buildButtonSpec(
        props as never,
        flattenText(props.children as ReactNode),
      );
      const onPress = (props as { onPress?: () => void }).onPress;
      if (ctx.handlers && node.agent?.id && typeof onPress === "function") {
        ctx.handlers.set(node.agent.id, onPress);
      }
      return node;
    }
    case "field":
      return buildFieldSpec(props as never);
    case "divider":
      return buildDividerSpec(props as never);
    case "spacer":
      return buildSpacerSpec(props as never);
    case "image":
      return buildImageSpec(props as never);
  }
}

// --- Framework hooks (work in both DOM and IR paths) ------------------------

/**
 * State that works on every surface. On a DOM surface it delegates to React's
 * `useState`; during IR evaluation it reads/writes the host's persistent store
 * keyed by component path + hook order, and the setter re-snapshots the frame.
 */
export function useSpatialState<T>(
  initial: T | (() => T),
): [T, (next: T | ((prev: T) => T)) => void] {
  const frame = currentFrame;
  if (!frame) {
    // DOM surface: real React.
    return reactUseState(initial);
  }
  const key = `${frame.path}#${frame.hookIndex++}`;
  const store = frame.store;
  const value = store?.has(key)
    ? (store.get(key) as T)
    : typeof initial === "function"
      ? (initial as () => T)()
      : initial;
  const requestRender = frame.requestRender;
  const setter = (next: T | ((prev: T) => T)) => {
    const prev = (store?.has(key) ? store.get(key) : value) as T;
    const resolved =
      typeof next === "function" ? (next as (p: T) => T)(prev) : next;
    store?.set(key, resolved);
    requestRender?.();
  };
  return [value, setter];
}

/** Memoised value that works on every surface. */
export function useSpatialMemo<T>(
  factory: () => T,
  deps?: readonly unknown[],
): T {
  if (!currentFrame) {
    return reactUseMemo(factory, deps ?? []);
  }
  // Snapshot evaluation: recompute each frame (cheap, deterministic).
  return factory();
}

/** Ref that works on every surface. */
export function useSpatialRef<T>(initial: T): { current: T } {
  const frame = currentFrame;
  if (!frame) {
    return reactUseRef(initial);
  }
  const key = `${frame.path}#ref#${frame.hookIndex++}`;
  const store = frame.store;
  if (store && !store.has(key)) store.set(key, { current: initial });
  return (
    (store?.get(key) as { current: T } | undefined) ?? { current: initial }
  );
}

/** True while the current call stack is inside an IR (terminal) evaluation. */
export function isEvaluatingToIR(): boolean {
  return currentFrame !== null;
}
