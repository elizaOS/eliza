/**
 * ui-renderer.tsx — General-purpose json-render declarative UI renderer.
 *
 * Renders a UiSpec tree into React components. Supports:
 *   - 35+ component types (layout, typography, form, data, feedback, nav, viz, interaction)
 *   - State binding via statePath
 *   - Dynamic values via $path references
 *   - Conditional props via $cond expressions
 *   - List rendering via repeat config
 *   - Event bindings via on.press / on.change
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useApp } from "../state";
import { confirmDesktopAction, resolveAppAssetUrl } from "../utils";
import { getByPath, setByPath } from "./config-catalog";
import type {
  AuthState,
  CondExpr,
  UiAction,
  UiElement,
  UiRenderContext,
  UiSpec,
  ValidationCheck,
  VisibilityCondition,
} from "./ui-spec";

const UiContext = createContext<UiRenderContext | null>(null);

const BLOCKED_LINK_PROTOCOLS = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
]);

function useUiCtx(): UiRenderContext {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("UiRenderer context missing");
  return ctx;
}

// ── Dynamic value resolution ────────────────────────────────────────

function resolveProp(value: unknown, ctx: UiRenderContext): unknown {
  if (value == null) return value;

  // $data.path string prefix (simpler syntax for AI)
  if (typeof value === "string" && value.startsWith("$data.")) {
    const path = value.slice(6); // strip "$data."
    if (path.startsWith("$item/") && ctx.repeatItem) {
      return ctx.repeatItem[path.slice(6)];
    }
    return getByPath(ctx.state, path);
  }

  // $path reference
  if (
    typeof value === "object" &&
    "$path" in (value as Record<string, unknown>)
  ) {
    const path = (value as { $path: string }).$path;
    if (path.startsWith("$item/") && ctx.repeatItem) {
      return ctx.repeatItem[path.slice(6)];
    }
    return getByPath(ctx.state, path);
  }

  // $cond expression
  if (
    typeof value === "object" &&
    "$cond" in (value as Record<string, unknown>)
  ) {
    const expr = value as CondExpr;
    const cond = expr.$cond;
    let result = false;

    if (cond.eq) {
      const [a, b] = cond.eq.map((v) => resolveProp(v, ctx));
      result = a === b;
    } else if (cond.neq) {
      const [a, b] = cond.neq.map((v) => resolveProp(v, ctx));
      result = a !== b;
    } else if (cond.gt) {
      const [a, b] = cond.gt.map((v) => resolveProp(v, ctx));
      result = Number(a) > Number(b);
    } else if (cond.lt) {
      const [a, b] = cond.lt.map((v) => resolveProp(v, ctx));
      result = Number(a) < Number(b);
    } else if (cond.truthy) {
      result = !!resolveProp(cond.truthy, ctx);
    } else if (cond.falsy) {
      result = !resolveProp(cond.falsy, ctx);
    } else if (cond.path) {
      result = !!getByPath(ctx.state, cond.path);
    }

    return result ? resolveProp(expr.$then, ctx) : resolveProp(expr.$else, ctx);
  }

  // Object with path references
  if (
    typeof value === "object" &&
    value !== null &&
    "path" in (value as Record<string, unknown>)
  ) {
    const p = (value as { path: string }).path;
    if (p.startsWith("$item/") && ctx.repeatItem) {
      return ctx.repeatItem[p.slice(6)];
    }
    return getByPath(ctx.state, p);
  }

  return value;
}

function resolveProps(
  props: Record<string, unknown>,
  ctx: UiRenderContext,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    resolved[k] = resolveProp(v, ctx);
  }
  return resolved;
}

// ── Visibility evaluation ────────────────────────────────────────────

export function evaluateUiVisibility(
  condition: VisibilityCondition | undefined,
  state: Record<string, unknown>,
  auth?: AuthState,
): boolean {
  if (!condition) return true;

  // Path-based
  if ("path" in condition && "operator" in condition) {
    const val = getByPath(state, condition.path);
    const target = condition.value;
    switch (condition.operator) {
      case "eq":
        return val === target;
      case "ne":
        return val !== target;
      case "gt":
        return Number(val) > Number(target);
      case "gte":
        return Number(val) >= Number(target);
      case "lt":
        return Number(val) < Number(target);
      case "lte":
        return Number(val) <= Number(target);
      default:
        return true;
    }
  }

  // Auth-based
  if ("auth" in condition) {
    if (!auth) return false;
    switch (condition.auth) {
      case "signedIn":
        return auth.isSignedIn;
      case "signedOut":
        return !auth.isSignedIn;
      case "admin":
        return auth.roles?.includes("admin") ?? false;
      default:
        return auth.roles?.includes(condition.auth) ?? false;
    }
  }

  // Logic combinators
  if ("and" in condition)
    return condition.and.every((c) => evaluateUiVisibility(c, state, auth));
  if ("or" in condition)
    return condition.or.some((c) => evaluateUiVisibility(c, state, auth));
  if ("not" in condition)
    return !evaluateUiVisibility(condition.not, state, auth);

  return true;
}

export function sanitizeLinkHref(href: unknown): string {
  // Strip ASCII control chars (tab, LF, CR) that browsers silently remove
  // during URL parsing, preventing bypass attacks like "java\nscript:alert(1)".
  const raw = String(href ?? "#")
    .trim()
    .replace(/[\t\n\r]/g, "");
  if (!raw) return "#";

  // Keep relative/hash links unchanged.
  if (
    raw.startsWith("#") ||
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("?")
  ) {
    return raw;
  }

  const match = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(raw);
  if (!match) return raw;

  const protocol = match[1].toLowerCase();
  if (BLOCKED_LINK_PROTOCOLS.has(protocol)) return "#";

  return raw;
}

// ── Built-in validators ─────────────────────────────────────────────

const BUILTIN_VALIDATORS: Record<
  string,
  (value: unknown, args?: Record<string, unknown>) => boolean
> = {
  required: (v) => v != null && v !== "",
  email: (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  minLength: (v, args) =>
    typeof v === "string" && v.length >= Number(args?.length ?? 0),
  maxLength: (v, args) =>
    typeof v === "string" && v.length <= Number(args?.length ?? Infinity),
  pattern: (v, args) => {
    if (typeof v !== "string" || !args?.pattern) return true;
    try {
      return new RegExp(String(args.pattern)).test(v);
    } catch {
      return true;
    }
  },
  min: (v, args) => Number(v) >= Number(args?.value ?? -Infinity),
  max: (v, args) => Number(v) <= Number(args?.value ?? Infinity),
};

// ── Validation runner ───────────────────────────────────────────────

export function runValidation(
  checks: ValidationCheck[],
  value: unknown,
  customValidators?: Record<
    string,
    (
      value: unknown,
      args?: Record<string, unknown>,
    ) => boolean | Promise<boolean>
  >,
): string[] {
  const errors: string[] = [];
  for (const check of checks) {
    const fn = BUILTIN_VALIDATORS[check.fn] ?? customValidators?.[check.fn];
    if (fn) {
      const result = fn(value, check.args);
      // Handle sync validators only (async handled separately)
      if (result === false) errors.push(check.message);
    }
  }
  return errors;
}

// ── State helpers ───────────────────────────────────────────────────

function useStatePath(statePath: string | undefined, ctx: UiRenderContext) {
  const value = statePath ? getByPath(ctx.state, statePath) : undefined;
  const setValue = useCallback(
    (v: unknown) => {
      if (statePath) ctx.setState(statePath, v);
    },
    [statePath, ctx],
  );
  return [value, setValue] as const;
}

// ── Fire event action ───────────────────────────────────────────────

function fireEvent(action: UiAction | undefined, ctx: UiRenderContext) {
  if (!action) return;

  const execute = () => {
    if (action.action === "setState" && action.params) {
      const p = action.params as { path: string; value: unknown };
      ctx.setState(p.path, p.value);
      if (action.onSuccess && ctx.onAction) {
        ctx.onAction(action.onSuccess.action, action.onSuccess.params);
      }
    } else if (ctx.onAction) {
      try {
        ctx.onAction(action.action, action.params);
        if (action.onSuccess)
          ctx.onAction(action.onSuccess.action, action.onSuccess.params);
      } catch {
        if (action.onError && ctx.onAction)
          ctx.onAction(action.onError.action, action.onError.params);
      }
    }
  };

  void (async () => {
    if (action.confirm) {
      const ok = await confirmDesktopAction({
        title: action.confirm.title,
        message: action.confirm.message ?? "",
        confirmLabel: "Confirm",
        cancelLabel: "Cancel",
        type: "question",
      });
      if (!ok) return;
    }
    execute();
  })();
}

// ── Gap / size maps ─────────────────────────────────────────────────

const GAP: Record<string, string> = {
  none: "gap-0",
  xs: "gap-0.5",
  sm: "gap-1.5",
  md: "gap-3",
  lg: "gap-5",
  xl: "gap-8",
};

const ALIGN: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
};

const JUSTIFY: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
};

// ── Tailwind class constants ────────────────────────────────────────

const INPUT_CLS =
  "w-full px-2 py-[5px] border border-[var(--border)] bg-[var(--card)] text-xs font-[var(--mono)] transition-colors focus:border-[var(--accent)] focus:outline-none box-border h-[30px]";

// ══════════════════════════════════════════════════════════════════════
// COMPONENT REGISTRY
// ══════════════════════════════════════════════════════════════════════

type ComponentFn = (
  props: Record<string, unknown>,
  children: React.ReactNode,
  ctx: UiRenderContext,
  el: UiElement,
) => React.ReactNode;

// ── Layout ──────────────────────────────────────────────────────────

const StackComponent: ComponentFn = (props, children) => {
  const dir = props.direction === "horizontal" ? "flex-row" : "flex-col";
  const gap = GAP[String(props.gap ?? "md")] ?? "gap-3";
  const align = ALIGN[String(props.align ?? "stretch")] ?? "";
  const justify = JUSTIFY[String(props.justify ?? "start")] ?? "";
  return (
    <div className={`flex ${dir} ${gap} ${align} ${justify}`}>{children}</div>
  );
};

const GridComponent: ComponentFn = (props, children) => {
  const cols = Number(props.columns ?? 2);
  const gap = GAP[String(props.gap ?? "md")] ?? "gap-3";
  return (
    <div
      className={`grid ${gap}`}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {children}
    </div>
  );
};

const CardComponent: ComponentFn = (props, children) => {
  const maxW = props.maxWidth === "full" ? "max-w-full" : "";
  return (
    <div
      className={`border border-[var(--border)] bg-[var(--card)] p-4 ${maxW}`}
    >
      {props.title ? (
        <div className="font-bold text-sm mb-0.5">{String(props.title)}</div>
      ) : null}
      {props.description ? (
        <div className="text-xs text-[var(--muted)] mb-3">
          {String(props.description)}
        </div>
      ) : null}
      {children}
    </div>
  );
};

const SeparatorComponent: ComponentFn = (props) => {
  const isVert = props.orientation === "vertical";
  return isVert ? (
    <div className="w-px bg-[var(--border)] self-stretch" />
  ) : (
    <hr className="border-t border-[var(--border)] my-2" />
  );
};

// ── Typography ──────────────────────────────────────────────────────

const HeadingComponent: ComponentFn = (props) => {
  const text = String(props.text ?? "");
  const level = String(props.level ?? "h2");
  const cls =
    level === "h1"
      ? "text-xl font-bold"
      : level === "h3"
        ? "text-sm font-bold"
        : "text-base font-bold";
  return <div className={cls}>{text}</div>;
};

const TextComponent: ComponentFn = (props) => {
  const text = String(props.text ?? "");
  const variant = String(props.variant ?? "body");
  const cls: Record<string, string> = {
    body: "text-sm",
    caption: "text-xs text-[var(--muted)]",
    muted: "text-sm text-[var(--muted)]",
    lead: "text-sm font-medium",
    code: "text-xs font-mono bg-[var(--bg-hover)] px-1.5 py-0.5 border border-[var(--border)]",
  };
  return <div className={cls[variant] ?? "text-sm"}>{text}</div>;
};

// ── Form ────────────────────────────────────────────────────────────

const InputComponent: ComponentFn = (props, _children, ctx, el) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const sp = props.statePath as string | undefined;
  const errors = sp ? ctx.fieldErrors?.[sp] : undefined;
  const validateOn = el.validation?.validateOn ?? "blur";

  const handleChange = (v: string) => {
    setValue(v);
    if (validateOn === "change" && sp && ctx.validateField)
      ctx.validateField(sp);
  };
  const handleBlur = () => {
    if (validateOn === "blur" && sp && ctx.validateField) ctx.validateField(sp);
  };

  return (
    <div className="flex flex-col gap-1">
      {props.label ? (
        <span className="text-xs font-semibold">{String(props.label)}</span>
      ) : null}
      <input
        className={`${INPUT_CLS}${errors?.length ? " border-[var(--destructive)]" : ""}`}
        type={String(props.type ?? "text")}
        name={String(props.name ?? "")}
        placeholder={String(props.placeholder ?? "")}
        value={String(value ?? "")}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
      />
      {errors?.length ? (
        <div className="flex flex-col gap-0.5">
          {errors.map((err) => (
            <span key={err} className="text-[10px] text-[var(--destructive)]">
              {err}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const TextareaComponent: ComponentFn = (props, _children, ctx, el) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const sp = props.statePath as string | undefined;
  const errors = sp ? ctx.fieldErrors?.[sp] : undefined;
  const validateOn = el.validation?.validateOn ?? "blur";

  const handleChange = (v: string) => {
    setValue(v);
    if (validateOn === "change" && sp && ctx.validateField)
      ctx.validateField(sp);
  };
  const handleBlur = () => {
    if (validateOn === "blur" && sp && ctx.validateField) ctx.validateField(sp);
  };

  return (
    <div className="flex flex-col gap-1">
      {props.label ? (
        <span className="text-xs font-semibold">{String(props.label)}</span>
      ) : null}
      <textarea
        className={`w-full px-2 py-[5px] border border-[var(--border)] bg-[var(--card)] text-xs font-[var(--mono)] transition-colors focus:border-[var(--accent)] focus:outline-none box-border min-h-[64px] resize-y${errors?.length ? " border-[var(--destructive)]" : ""}`}
        name={String(props.name ?? "")}
        placeholder={String(props.placeholder ?? "")}
        rows={Number(props.rows ?? 3)}
        value={String(value ?? "")}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
      />
      {errors?.length ? (
        <div className="flex flex-col gap-0.5">
          {errors.map((err) => (
            <span key={err} className="text-[10px] text-[var(--destructive)]">
              {err}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const SelectComponent: ComponentFn = (props, _children, ctx, el) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const options =
    (props.options as Array<{ label: string; value: string }>) ?? [];
  const sp = props.statePath as string | undefined;
  const errors = sp ? ctx.fieldErrors?.[sp] : undefined;
  const validateOn = el.validation?.validateOn ?? "blur";

  const handleChange = (v: string) => {
    setValue(v);
    if (validateOn === "change" && sp && ctx.validateField)
      ctx.validateField(sp);
  };
  const handleBlur = () => {
    if (validateOn === "blur" && sp && ctx.validateField) ctx.validateField(sp);
  };

  return (
    <div className="flex flex-col gap-1">
      {props.label ? (
        <span className="text-xs font-semibold">{String(props.label)}</span>
      ) : null}
      <select
        className={`${INPUT_CLS} appearance-auto${errors?.length ? " border-[var(--destructive)]" : ""}`}
        value={String(value ?? "")}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
      >
        {props.placeholder ? (
          <option value="">{String(props.placeholder)}</option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {errors?.length ? (
        <div className="flex flex-col gap-0.5">
          {errors.map((err) => (
            <span key={err} className="text-[10px] text-[var(--destructive)]">
              {err}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const CheckboxComponent: ComponentFn = (props, _children, ctx) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  return (
    <span className="flex items-center gap-2 text-xs cursor-pointer">
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => setValue(e.target.checked)}
      />
      <span className="font-semibold">{String(props.label ?? "")}</span>
    </span>
  );
};

const RadioComponent: ComponentFn = (props, _children, ctx) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const options =
    (props.options as Array<{ label: string; value: string }>) ?? [];
  return (
    <div className="flex flex-col gap-1">
      {props.label ? (
        <span className="text-xs font-semibold mb-0.5">
          {String(props.label)}
        </span>
      ) : null}
      {options.map((o) => (
        <span
          key={o.value}
          className="flex items-center gap-2 text-xs cursor-pointer"
        >
          <input
            type="radio"
            name={String(props.name ?? "")}
            value={o.value}
            checked={value === o.value}
            onChange={() => setValue(o.value)}
          />
          <span>{o.label}</span>
        </span>
      ))}
    </div>
  );
};

const SwitchComponent: ComponentFn = (props, _children, ctx) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const checked = !!value;
  return (
    <span className="flex items-center gap-2 cursor-pointer">
      <button
        type="button"
        className={`relative w-9 h-[18px] transition-colors ${checked ? "bg-[var(--accent)]" : "bg-[var(--muted)]"}`}
        onClick={() => setValue(!checked)}
      >
        <div
          className={`absolute top-0.5 w-[14px] h-[14px] bg-white transition-all ${checked ? "left-5" : "left-0.5"}`}
        />
      </button>
      <span className="text-xs font-semibold">{String(props.label ?? "")}</span>
    </span>
  );
};

const SliderComponent: ComponentFn = (props, _children, ctx) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  return (
    <div className="flex flex-col gap-1">
      {props.label ? (
        <div className="flex justify-between text-xs">
          <span className="font-semibold">{String(props.label)}</span>
          <span className="text-[var(--muted)]">
            {String(value ?? props.min ?? 0)}
          </span>
        </div>
      ) : null}
      <input
        type="range"
        min={Number(props.min ?? 0)}
        max={Number(props.max ?? 100)}
        step={Number(props.step ?? 1)}
        value={Number(value ?? props.min ?? 0)}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-full"
        style={{ accentColor: "var(--accent)" }}
      />
    </div>
  );
};

const ToggleComponent: ComponentFn = (props, _children, ctx, el) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const pressed = !!value;
  return (
    <button
      type="button"
      className={`px-3 py-1.5 text-xs border cursor-pointer transition-colors ${
        pressed
          ? "bg-[var(--accent)] text-[var(--accent-foreground,#1a1f26)] border-[var(--accent)]"
          : "bg-[var(--card)] text-[var(--text)] border-[var(--border)] hover:bg-[var(--bg-hover)]"
      }`}
      onClick={() => {
        setValue(!pressed);
        fireEvent(el.on?.press, ctx);
      }}
    >
      {String(props.label ?? "Toggle")}
    </button>
  );
};

const ToggleGroupComponent: ComponentFn = (props, _children, ctx) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const items = (props.items as Array<{ label: string; value: string }>) ?? [];
  const isMultiple = props.type === "multiple";
  const selected = new Set(Array.isArray(value) ? (value as string[]) : []);

  const toggle = (v: string) => {
    if (isMultiple) {
      const next = new Set(selected);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      setValue([...next]);
    } else {
      setValue(v);
    }
  };

  return (
    <div className="flex gap-1">
      {items.map((item) => {
        const active = isMultiple
          ? selected.has(item.value)
          : value === item.value;
        return (
          <button
            key={item.value}
            type="button"
            className={`px-2.5 py-1 text-xs border cursor-pointer transition-colors ${
              active
                ? "bg-[var(--accent)] text-[var(--accent-foreground,#1a1f26)] border-[var(--accent)]"
                : "bg-[var(--card)] text-[var(--text)] border-[var(--border)] hover:bg-[var(--bg-hover)]"
            }`}
            onClick={() => toggle(item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
};

const ButtonGroupComponent: ComponentFn = (props, _children, ctx) => {
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const buttons =
    (props.buttons as Array<{ label: string; value: string }>) ?? [];
  return (
    <div className="flex gap-1">
      {buttons.map((btn) => {
        const active = value === btn.value;
        return (
          <button
            key={btn.value}
            type="button"
            className={`px-3 py-1.5 text-xs border cursor-pointer transition-colors ${
              active
                ? "bg-[var(--accent)] text-[var(--accent-foreground,#1a1f26)] border-[var(--accent)]"
                : "bg-[var(--card)] text-[var(--text)] border-[var(--border)] hover:bg-[var(--bg-hover)]"
            }`}
            onClick={() => setValue(btn.value)}
          >
            {btn.label}
          </button>
        );
      })}
    </div>
  );
};

// ── Data Display ────────────────────────────────────────────────────

const TableComponent: ComponentFn = (props) => {
  const columns = (props.columns as string[]) ?? [];
  const rows = (props.rows as string[][]) ?? [];
  return (
    <div className="overflow-x-auto">
      {props.caption ? (
        <div className="text-xs font-semibold mb-1.5">
          {String(props.caption)}
        </div>
      ) : null}
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="text-left px-2.5 py-1.5 border-b border-[var(--border)] font-semibold text-[var(--muted)]"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.join("|")}
              className="border-b border-[var(--border)] last:border-b-0"
            >
              {row.map((cell) => (
                <td key={cell} className="px-2.5 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const CarouselComponent: ComponentFn = (props) => {
  const { t } = useApp();
  const items =
    (props.items as Array<{ title: string; description: string }>) ?? [];
  const [current, setCurrent] = useState(0);
  return (
    <div className="relative">
      <div className="border border-[var(--border)] bg-[var(--bg-hover)] p-4 min-h-[60px]">
        {items[current] && (
          <div>
            <div className="text-xs font-bold">{items[current].title}</div>
            <div className="text-xs text-[var(--muted)] mt-0.5">
              {items[current].description}
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-center gap-2 mt-2">
        <button
          type="button"
          className="text-xs px-2 py-0.5 border border-[var(--border)] bg-[var(--card)] cursor-pointer hover:bg-[var(--bg-hover)]"
          onClick={() => setCurrent((p) => Math.max(0, p - 1))}
          disabled={current === 0}
        >
          {t("ui-renderer.Larr")}
        </button>
        <span className="text-[10px] text-[var(--muted)] self-center">
          {current + 1} / {items.length}
        </span>
        <button
          type="button"
          className="text-xs px-2 py-0.5 border border-[var(--border)] bg-[var(--card)] cursor-pointer hover:bg-[var(--bg-hover)]"
          onClick={() => setCurrent((p) => Math.min(items.length - 1, p + 1))}
          disabled={current === items.length - 1}
        >
          {t("ui-renderer.Rarr")}
        </button>
      </div>
    </div>
  );
};

const BadgeComponent: ComponentFn = (props) => {
  const variant = String(props.variant ?? "default");
  const cls: Record<string, string> = {
    default: "bg-[var(--surface)] text-[var(--text)] border-[var(--border)]",
    success: "bg-[rgba(22,163,106,0.1)] text-[var(--ok)] border-[var(--ok)]",
    warning:
      "bg-[rgba(243,156,18,0.1)] text-[var(--warn,#f39c12)] border-[var(--warn,#f39c12)]",
    error:
      "bg-[rgba(231,76,60,0.1)] text-[var(--destructive)] border-[var(--destructive)]",
    info: "bg-[rgba(52,152,219,0.1)] text-[var(--accent)] border-[var(--accent)]",
  };
  return (
    <span
      className={`inline-block text-[10px] font-medium px-2 py-0.5 border ${cls[variant] ?? cls.default}`}
    >
      {String(props.text ?? "")}
    </span>
  );
};

const AvatarComponent: ComponentFn = (props) => {
  const name = String(props.name ?? "?");
  const size =
    props.size === "lg"
      ? "w-10 h-10 text-sm"
      : props.size === "sm"
        ? "w-6 h-6 text-[10px]"
        : "w-8 h-8 text-xs";
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div
      className={`${size} rounded-full bg-[var(--accent)] text-[var(--accent-foreground,#1a1f26)] flex items-center justify-center font-bold shrink-0`}
    >
      {initials}
    </div>
  );
};

const ImageComponent: ComponentFn = (props) => {
  const src = props.src as string | undefined;
  const resolvedSrc = src ? resolveAppAssetUrl(src) : undefined;
  const alt = String(props.alt ?? "");
  const w = props.width ? `${props.width}px` : "auto";
  const h = props.height ? `${props.height}px` : "auto";
  return resolvedSrc ? (
    <img
      src={resolvedSrc}
      alt={alt}
      style={{ width: w, height: h }}
      className="object-cover border border-[var(--border)]"
    />
  ) : (
    <div
      className="bg-[var(--bg-hover)] border border-[var(--border)] flex items-center justify-center text-xs text-[var(--muted)]"
      style={{ width: w, height: h }}
    >
      {alt || "Image"}
    </div>
  );
};

// ── Feedback ────────────────────────────────────────────────────────

const AlertComponent: ComponentFn = (props) => {
  const type = String(props.type ?? "info");
  const borderCls: Record<string, string> = {
    info: "border-[var(--accent)]",
    success: "border-[var(--ok)]",
    warning: "border-[var(--warn,#f39c12)]",
    error: "border-[var(--destructive)]",
  };
  const textCls: Record<string, string> = {
    info: "text-[var(--accent)]",
    success: "text-[var(--ok)]",
    warning: "text-[var(--warn,#f39c12)]",
    error: "text-[var(--destructive)]",
  };
  return (
    <div
      className={`border-l-[3px] ${borderCls[type] ?? ""} bg-[var(--bg-hover)] px-3 py-2`}
    >
      {props.title ? (
        <div className={`text-xs font-bold ${textCls[type] ?? ""}`}>
          {String(props.title)}
        </div>
      ) : null}
      {props.message ? (
        <div className="text-xs text-[var(--text)] mt-0.5">
          {String(props.message)}
        </div>
      ) : null}
    </div>
  );
};

const ProgressComponent: ComponentFn = (props) => {
  const value = Number(props.value ?? 0);
  const max = Number(props.max ?? 100);
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="flex flex-col gap-1">
      {props.label ? (
        <div className="flex justify-between text-xs">
          <span className="font-semibold">{String(props.label)}</span>
          <span className="text-[var(--muted)]">{Math.round(pct)}%</span>
        </div>
      ) : null}
      <div className="w-full h-2 bg-[var(--bg-hover)] border border-[var(--border)] overflow-hidden">
        <div
          className="h-full bg-[var(--accent)] transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

const RatingComponent: ComponentFn = (props) => {
  const value = Number(props.value ?? 0);
  const max = Number(props.max ?? 5);
  return (
    <div className="flex flex-col gap-1">
      {props.label ? (
        <div className="text-xs font-semibold">{String(props.label)}</div>
      ) : null}
      <div className="flex gap-0.5">
        {Array.from({ length: max }, (_, i) => i + 1).map((starValue) => (
          <span
            key={starValue}
            className={`text-sm ${starValue <= value ? "text-[var(--warn,#f39c12)]" : "text-[var(--muted)] opacity-30"}`}
          >
            ★
          </span>
        ))}
      </div>
    </div>
  );
};

const SkeletonComponent: ComponentFn = (props) => {
  const w = props.width ? String(props.width) : "100%";
  const h = props.height ? String(props.height) : "20px";
  const rounded = props.rounded ? "rounded" : "";
  return (
    <div
      className={`bg-[var(--bg-hover)] animate-pulse ${rounded}`}
      style={{ width: w, height: h }}
    />
  );
};

const SpinnerComponent: ComponentFn = (props) => {
  const size =
    props.size === "lg"
      ? "w-8 h-8"
      : props.size === "sm"
        ? "w-4 h-4"
        : "w-6 h-6";
  return (
    <div className="flex items-center gap-2">
      <div
        className={`${size} border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin`}
      />
      {props.label ? (
        <span className="text-xs text-[var(--muted)]">
          {String(props.label)}
        </span>
      ) : null}
    </div>
  );
};

// ── Navigation ──────────────────────────────────────────────────────

const ButtonComponent: ComponentFn = (props, _children, ctx, el) => {
  const variant = String(props.variant ?? "primary");
  const cls: Record<string, string> = {
    primary:
      "bg-[var(--accent)] text-[var(--accent-foreground,#1a1f26)] border-[var(--accent)] hover:opacity-90",
    secondary:
      "bg-[var(--card)] text-[var(--text)] border-[var(--border)] hover:bg-[var(--bg-hover)]",
    danger:
      "bg-[var(--destructive)] text-white border-[var(--destructive)] hover:opacity-90",
    ghost:
      "bg-transparent text-[var(--text)] border-transparent hover:bg-[var(--bg-hover)]",
  };
  return (
    <button
      type="button"
      className={`px-3 py-1.5 text-xs font-medium border cursor-pointer transition-colors ${cls[variant] ?? cls.primary}`}
      disabled={!!props.disabled}
      onClick={() => fireEvent(el.on?.press, ctx)}
    >
      {String(props.label ?? "Button")}
    </button>
  );
};

const LinkComponent: ComponentFn = (props, _children, ctx, el) => {
  const safeHref = sanitizeLinkHref(props.href);

  return (
    <a
      href={safeHref}
      className="text-xs text-[var(--accent)] underline hover:opacity-80"
      target={props.external ? "_blank" : undefined}
      rel={props.external ? "noopener noreferrer" : undefined}
      onClick={(e) => {
        if (el.on?.press) {
          e.preventDefault();
          fireEvent(el.on.press, ctx);
        }
      }}
    >
      {String(props.label ?? props.href ?? "Link")}
    </a>
  );
};

const DropdownMenuComponent: ComponentFn = (props, _children, ctx) => {
  const [open, setOpen] = useState(false);
  const items = (props.items as Array<{ label: string; value: string }>) ?? [];
  return (
    <div className="relative inline-block">
      <button
        type="button"
        className="px-3 py-1.5 text-xs border border-[var(--border)] bg-[var(--card)] cursor-pointer hover:bg-[var(--bg-hover)]"
        onClick={() => setOpen(!open)}
      >
        {String(props.label ?? "Menu")} ▾
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[120px] border border-[var(--border)] bg-[var(--card)] shadow-md z-10">
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              className="block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-hover)] cursor-pointer"
              onClick={() => {
                setOpen(false);
                if (ctx.onAction)
                  ctx.onAction("menuSelect", {
                    value: item.value,
                    label: item.label,
                  });
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const TabsComponent: ComponentFn = (props, _children, ctx) => {
  const tabs =
    (props.tabs as Array<{ label: string; value: string; content: string }>) ??
    [];
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const active = String(value ?? props.defaultValue ?? tabs[0]?.value ?? "");
  const activeTab = tabs.find((t) => t.value === active);
  return (
    <div>
      <div className="flex border-b border-[var(--border)]">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`px-3 py-1.5 text-xs cursor-pointer transition-colors ${
              tab.value === active
                ? "border-b-2 border-[var(--accent)] text-[var(--accent)] font-semibold"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
            onClick={() => setValue(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab && <div className="py-3 text-xs">{activeTab.content}</div>}
    </div>
  );
};

const PaginationComponent: ComponentFn = (props, _children, ctx) => {
  const total = Number(props.totalPages ?? 1);
  const [value, setValue] = useStatePath(
    props.statePath as string | undefined,
    ctx,
  );
  const current = Number(value ?? 1);
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="px-2 py-1 text-xs border border-[var(--border)] bg-[var(--card)] cursor-pointer hover:bg-[var(--bg-hover)] disabled:opacity-40"
        disabled={current <= 1}
        onClick={() => setValue(current - 1)}
      >
        ←
      </button>
      {Array.from({ length: total }, (_, i) => i + 1).map((page) => (
        <button
          key={page}
          type="button"
          className={`px-2 py-1 text-xs border cursor-pointer ${
            page === current
              ? "bg-[var(--accent)] text-[var(--accent-foreground,#1a1f26)] border-[var(--accent)]"
              : "border-[var(--border)] bg-[var(--card)] hover:bg-[var(--bg-hover)]"
          }`}
          onClick={() => setValue(page)}
        >
          {page}
        </button>
      ))}
      <button
        type="button"
        className="px-2 py-1 text-xs border border-[var(--border)] bg-[var(--card)] cursor-pointer hover:bg-[var(--bg-hover)] disabled:opacity-40"
        disabled={current >= total}
        onClick={() => setValue(current + 1)}
      >
        →
      </button>
    </div>
  );
};

// ── Metric / KPI ────────────────────────────────────────────────────

const MetricComponent: ComponentFn = (props) => {
  const trend = props.trend as string | undefined;
  const trendColor =
    trend === "up"
      ? "text-green-400"
      : trend === "down"
        ? "text-red-400"
        : "text-[var(--muted)]";
  return (
    <div className="flex flex-col gap-0.5 p-3 rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <div className="text-[10px] text-[var(--muted)] uppercase tracking-wider font-medium">
        {String(props.label ?? "")}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-xl font-semibold text-[var(--txt)]">
          {props.value != null ? String(props.value) : "—"}
        </span>
        {props.unit != null && (
          <span className="text-xs text-[var(--muted)]">
            {String(props.unit)}
          </span>
        )}
      </div>
      {props.change != null && (
        <div className={`text-[11px] font-medium ${trendColor}`}>
          {String(props.change)}
        </div>
      )}
    </div>
  );
};

// ── Visualization ───────────────────────────────────────────────────

const BarGraphComponent: ComponentFn = (props) => {
  const data = (props.data as Array<{ label: string; value: number }>) ?? [];
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  return (
    <div>
      {props.title ? (
        <div className="text-xs font-bold mb-2">{String(props.title)}</div>
      ) : null}
      <div className="flex items-end gap-2 h-[100px]">
        {data.map((d) => (
          <div
            key={d.label}
            className="flex-1 flex flex-col items-center gap-0.5"
          >
            <div className="text-[9px] text-[var(--muted)]">{d.value}</div>
            <div
              className="w-full bg-[var(--accent)] transition-all duration-300 min-h-[2px]"
              style={{ height: `${(d.value / maxVal) * 80}px` }}
            />
            <div className="text-[9px] text-[var(--muted)] truncate max-w-full">
              {d.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const LineGraphComponent: ComponentFn = (props) => {
  const data = (props.data as Array<{ label: string; value: number }>) ?? [];
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const h = 80;
  const w = 100;
  const points = data.map((d, i) => ({
    x: (i / Math.max(data.length - 1, 1)) * w,
    y: h - (d.value / maxVal) * h,
  }));
  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");
  return (
    <div>
      {props.title ? (
        <div className="text-xs font-bold mb-2">{String(props.title)}</div>
      ) : null}
      <svg
        viewBox={`0 0 ${w} ${h + 20}`}
        className="w-full h-[100px]"
        preserveAspectRatio="none"
      >
        <title>{String(props.title ?? "Line graph")}</title>
        <path
          d={pathD}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((p) => (
          <circle
            key={`${p.x}:${p.y}`}
            cx={p.x}
            cy={p.y}
            r="3"
            fill="var(--accent)"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {data.map((d, i) => (
          <text
            key={`${d.label}:${d.value}`}
            x={points[i].x}
            y={h + 14}
            textAnchor="middle"
            fontSize="8"
            fill="var(--muted)"
          >
            {d.label}
          </text>
        ))}
      </svg>
    </div>
  );
};

// ── Interaction ─────────────────────────────────────────────────────

const TooltipComponent: ComponentFn = (props) => {
  const [show, setShow] = useState(false);
  return (
    <button
      type="button"
      className="relative inline-block"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      onClick={() => setShow((prev) => !prev)}
    >
      <span className="text-xs text-[var(--accent)] underline cursor-help">
        {String(props.text ?? "Hover")}
      </span>
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[10px] bg-[var(--text)] text-[var(--card)] whitespace-nowrap z-10">
          {String(props.content ?? "")}
        </div>
      )}
    </button>
  );
};

const PopoverComponent: ComponentFn = (props) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        className="text-xs text-[var(--accent)] underline cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        {String(props.trigger ?? "Click")}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 p-3 border border-[var(--border)] bg-[var(--card)] shadow-md z-10 min-w-[150px]">
          <div className="text-xs">{String(props.content ?? "")}</div>
          <button
            type="button"
            className="text-[10px] text-[var(--muted)] mt-1 cursor-pointer hover:text-[var(--text)]"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
};

const CollapsibleComponent: ComponentFn = (props, children) => {
  const [open, setOpen] = useState(!!props.defaultOpen);
  return (
    <div className="border border-[var(--border)]">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span
          className="text-[10px] transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          &#9654;
        </span>
        {String(props.title ?? "Collapsible")}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
};

const AccordionComponent: ComponentFn = (props) => {
  const items =
    (props.items as Array<{ title: string; content: string }>) ?? [];
  const isSingle = props.type === "single";
  const [openSet, setOpenSet] = useState<Set<number>>(new Set());

  const toggle = (idx: number) => {
    setOpenSet((prev) => {
      const next = isSingle ? new Set<number>() : new Set(prev);
      if (prev.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="border border-[var(--border)] divide-y divide-[var(--border)]">
      {items.map((item, i) => (
        <div key={`${item.title}:${item.content}`}>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold cursor-pointer hover:bg-[var(--bg-hover)]"
            onClick={() => toggle(i)}
          >
            <span
              className="text-[10px] transition-transform"
              style={{ transform: openSet.has(i) ? "rotate(90deg)" : "none" }}
            >
              &#9654;
            </span>
            {item.title}
          </button>
          {openSet.has(i) && (
            <div className="px-3 pb-3 text-xs">{item.content}</div>
          )}
        </div>
      ))}
    </div>
  );
};

const DialogComponent: ComponentFn = (props, children, ctx) => {
  const openPath = props.openPath as string | undefined;
  const isOpen = openPath ? !!getByPath(ctx.state, openPath) : false;
  if (!isOpen) return null;
  const close = () => {
    if (openPath) ctx.setState(openPath, false);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          close();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md border border-[var(--border)] bg-[var(--card)] p-5 shadow-lg">
        <div className="flex items-center justify-between mb-3">
          <div>
            {props.title ? (
              <div className="font-bold text-sm">{String(props.title)}</div>
            ) : null}
            {props.description ? (
              <div className="text-xs text-[var(--muted)] mt-0.5">
                {String(props.description)}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="text-[var(--muted)] hover:text-[var(--text)] text-lg leading-none px-1 cursor-pointer"
            onClick={close}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

const DrawerComponent: ComponentFn = (props, children, ctx) => {
  const openPath = props.openPath as string | undefined;
  const isOpen = openPath ? !!getByPath(ctx.state, openPath) : false;
  if (!isOpen) return null;
  const close = () => {
    if (openPath) ctx.setState(openPath, false);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          close();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-h-[80vh] border-t border-[var(--border)] bg-[var(--card)] p-5 shadow-lg overflow-y-auto animate-[slide-up_200ms_ease]">
        <div className="w-10 h-1 bg-[var(--border)] mx-auto mb-3 rounded-full" />
        {props.title ? (
          <div className="font-bold text-sm">{String(props.title)}</div>
        ) : null}
        {props.description ? (
          <div className="text-xs text-[var(--muted)] mt-0.5 mb-3">
            {String(props.description)}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
};

// ── Component map ───────────────────────────────────────────────────

const COMPONENTS: Record<string, ComponentFn> = {
  // Layout
  Stack: StackComponent,
  Grid: GridComponent,
  Card: CardComponent,
  Separator: SeparatorComponent,
  // Typography
  Heading: HeadingComponent,
  Text: TextComponent,
  // Form
  Input: InputComponent,
  Textarea: TextareaComponent,
  Select: SelectComponent,
  Checkbox: CheckboxComponent,
  Radio: RadioComponent,
  Switch: SwitchComponent,
  Slider: SliderComponent,
  Toggle: ToggleComponent,
  ToggleGroup: ToggleGroupComponent,
  ButtonGroup: ButtonGroupComponent,
  // Data
  Table: TableComponent,
  Carousel: CarouselComponent,
  Badge: BadgeComponent,
  Avatar: AvatarComponent,
  Image: ImageComponent,
  // Feedback
  Alert: AlertComponent,
  Progress: ProgressComponent,
  Rating: RatingComponent,
  Skeleton: SkeletonComponent,
  Spinner: SpinnerComponent,
  // Navigation
  Button: ButtonComponent,
  Link: LinkComponent,
  DropdownMenu: DropdownMenuComponent,
  Tabs: TabsComponent,
  Pagination: PaginationComponent,
  // Metric
  Metric: MetricComponent,
  // Visualization
  BarGraph: BarGraphComponent,
  LineGraph: LineGraphComponent,
  // Interaction
  Tooltip: TooltipComponent,
  Popover: PopoverComponent,
  Collapsible: CollapsibleComponent,
  Accordion: AccordionComponent,
  Dialog: DialogComponent,
  Drawer: DrawerComponent,
};

// ══════════════════════════════════════════════════════════════════════
// ELEMENT RENDERER
// ══════════════════════════════════════════════════════════════════════

function ElementRenderer({ elementId }: { elementId: string }) {
  const { t } = useApp();
  const ctx = useUiCtx();
  const el = ctx.spec.elements[elementId];
  if (!el) return null;

  // Visibility check
  if (el.visible && !evaluateUiVisibility(el.visible, ctx.state, ctx.auth)) {
    return null;
  }

  const component = COMPONENTS[el.type];
  if (!component) {
    return (
      <div className="text-[10px] text-[var(--destructive)] border border-dashed border-[var(--destructive)] p-2">
        {t("ui-renderer.UnknownComponent")} {el.type}
      </div>
    );
  }

  const resolvedProps = resolveProps(el.props, ctx);

  // Handle repeat / list rendering
  if (el.repeat) {
    const listData = getByPath(ctx.state, el.repeat.path) as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(listData)) return null;

    return (
      <>
        {listData.map((item) => {
          const itemCtx: UiRenderContext = { ...ctx, repeatItem: item };
          const childNodes = el.children.map((childId) => (
            <UiContext.Provider key={childId} value={itemCtx}>
              <ElementRenderer elementId={childId} />
            </UiContext.Provider>
          ));
          const repeatKey = el.repeat?.key;
          const itemKey = String(
            repeatKey != null ? item[repeatKey] : Math.random(),
          );
          return (
            <React.Fragment key={itemKey}>
              {component(resolvedProps, childNodes, itemCtx, el)}
            </React.Fragment>
          );
        })}
      </>
    );
  }

  // Normal rendering: resolve children
  const childNodes = el.children.map((childId) => (
    <ElementRenderer key={childId} elementId={childId} />
  ));

  return <>{component(resolvedProps, childNodes, ctx, el)}</>;
}

// ══════════════════════════════════════════════════════════════════════
// ROOT RENDERER
// ══════════════════════════════════════════════════════════════════════

export interface UiRendererProps {
  spec: UiSpec;
  onAction?: (action: string, params?: Record<string, unknown>) => void;
  loading?: boolean;
  auth?: AuthState;
  validators?: Record<
    string,
    (
      value: unknown,
      args?: Record<string, unknown>,
    ) => boolean | Promise<boolean>
  >;
}

export function UiRenderer({
  spec,
  onAction,
  loading,
  auth,
  validators,
}: UiRendererProps) {
  const [state, setStateRaw] = useState<Record<string, unknown>>(() => ({
    ...spec.state,
  }));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const setState = useCallback((path: string, value: unknown) => {
    setStateRaw((prev) => {
      const next = { ...prev };
      setByPath(next, path, value);
      return next;
    });
  }, []);

  const validateField = useCallback(
    (statePath: string) => {
      // Find the element that has this statePath
      for (const el of Object.values(spec.elements)) {
        if (el.props.statePath === statePath && el.validation) {
          const value = getByPath(state, statePath);
          const errors = runValidation(el.validation.checks, value, validators);
          setFieldErrors((prev) => ({ ...prev, [statePath]: errors }));
          return;
        }
      }
    },
    [spec.elements, state, validators],
  );

  const ctx = useMemo<UiRenderContext>(
    () => ({
      spec,
      state,
      setState,
      onAction,
      auth,
      loading,
      validators,
      fieldErrors,
      validateField,
    }),
    [
      spec,
      state,
      setState,
      onAction,
      auth,
      loading,
      validators,
      fieldErrors,
      validateField,
    ],
  );

  // Loading skeleton when no elements
  if (loading && Object.keys(spec.elements).length === 0) {
    return (
      <div className="flex flex-col gap-3 animate-pulse">
        <div className="h-4 bg-[var(--bg-hover)] w-3/4" />
        <div className="h-3 bg-[var(--bg-hover)] w-1/2" />
        <div className="h-3 bg-[var(--bg-hover)] w-5/6" />
      </div>
    );
  }

  return (
    <UiContext.Provider value={ctx}>
      <ElementRenderer elementId={spec.root} />
    </UiContext.Provider>
  );
}

/** Get the full list of supported component types. */
export function getSupportedComponents(): string[] {
  return Object.keys(COMPONENTS);
}
