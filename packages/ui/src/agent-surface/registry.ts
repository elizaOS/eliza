/**
 * ViewAgentRegistry — the live, per-view store of agent-addressable elements.
 *
 * One registry exists per mounted view (keyed by `viewType:viewId`).
 * `useAgentElement` registers/updates/unregisters elements here; the
 * DynamicViewLoader interact handler reads it to satisfy agent capabilities;
 * `AgentElementOverlay` subscribes to it to draw indicators.
 */

import {
  type AgentActionResult,
  type AgentElementDescriptor,
  type AgentElementSnapshot,
  type AgentSurfaceSnapshot,
  type AgentViewType,
  CLICKABLE_ROLES,
  FILLABLE_ROLES,
} from "./types";

interface ElementRecord {
  descriptor: AgentElementDescriptor;
  getElement: () => HTMLElement | null;
  registeredAt: number;
}

function isFillable(descriptor: AgentElementDescriptor): boolean {
  if (typeof descriptor.fillable === "boolean") return descriptor.fillable;
  return FILLABLE_ROLES.has(descriptor.role ?? "region");
}

function isClickable(descriptor: AgentElementDescriptor): boolean {
  if (typeof descriptor.clickable === "boolean") return descriptor.clickable;
  if (descriptor.onActivate) return true;
  return CLICKABLE_ROLES.has(descriptor.role ?? "region");
}

function readDomValue(el: HTMLElement | null): unknown {
  if (!el) return undefined;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      return el.checked;
    }
    return el.value;
  }
  return undefined;
}

/**
 * Set a native input/textarea/select value in a way React's controlled inputs
 * observe — bypasses the React value setter then fires input/change events.
 * Shared with the DynamicViewLoader selector path.
 */
export function setNativeFieldValue(
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

export class ViewAgentRegistry {
  readonly viewId: string;
  readonly viewType: AgentViewType;

  private readonly elements = new Map<string, ElementRecord>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private highlight = false;

  constructor(viewId: string, viewType: AgentViewType) {
    this.viewId = viewId;
    this.viewType = viewType;
  }

  // ── registration ────────────────────────────────────────────────────────

  register(
    descriptor: AgentElementDescriptor,
    getElement: () => HTMLElement | null,
  ): () => void {
    this.elements.set(descriptor.id, {
      descriptor,
      getElement,
      registeredAt: this.version,
    });
    this.bump();
    return () => {
      const record = this.elements.get(descriptor.id);
      // Only delete if this is still the same registration (guards against a
      // remount registering before the prior unmount cleanup runs).
      if (record && record.getElement === getElement) {
        this.elements.delete(descriptor.id);
        this.bump();
      }
    };
  }

  update(id: string, patch: Partial<AgentElementDescriptor>): void {
    const record = this.elements.get(id);
    if (!record) return;
    record.descriptor = { ...record.descriptor, ...patch };
    this.bump();
  }

  // ── reactivity (useSyncExternalStore) ─────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Public version bump — used by `useAgentElement` when a live descriptor's
   *  rendered fields (label/status/…) change so subscribers re-read snapshots. */
  touch(): void {
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  // ── introspection ─────────────────────────────────────────────────────────

  private orderedRecords(): ElementRecord[] {
    return [...this.elements.values()].sort((a, b) => {
      const oa = a.descriptor.order ?? 100;
      const ob = b.descriptor.order ?? 100;
      if (oa !== ob) return oa - ob;
      return a.registeredAt - b.registeredAt;
    });
  }

  private snapshotRecord(record: ElementRecord): AgentElementSnapshot {
    const { descriptor } = record;
    const el = record.getElement();
    const role = descriptor.role ?? "region";
    const value = descriptor.getValue
      ? descriptor.getValue()
      : readDomValue(el);
    const rect = el?.getBoundingClientRect();
    const visible = rect ? rect.width > 0 && rect.height > 0 : false;
    const focused =
      typeof document !== "undefined" &&
      el != null &&
      (document.activeElement === el || el.contains(document.activeElement));
    return {
      id: descriptor.id,
      role,
      label: descriptor.label,
      group: descriptor.group,
      description: descriptor.description,
      status: descriptor.status,
      value,
      fillable: isFillable(descriptor),
      clickable: isClickable(descriptor),
      focused,
      visible,
      options: descriptor.options,
      bounds: rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : undefined,
    };
  }

  snapshot(): AgentSurfaceSnapshot {
    const elements = this.orderedRecords().map((r) => this.snapshotRecord(r));
    const focused = elements.find((e) => e.focused)?.id ?? null;
    return {
      viewId: this.viewId,
      viewType: this.viewType,
      elementCount: elements.length,
      focusedId: focused,
      elements,
      updatedAt: this.version,
    };
  }

  describe(id: string): AgentElementSnapshot | null {
    const record = this.elements.get(id);
    return record ? this.snapshotRecord(record) : null;
  }

  getFocusedId(): string | null {
    if (typeof document === "undefined") return null;
    const active = document.activeElement;
    if (!active) return null;
    for (const record of this.orderedRecords()) {
      const el = record.getElement();
      if (el && (el === active || el.contains(active))) {
        return record.descriptor.id;
      }
    }
    return null;
  }

  size(): number {
    return this.elements.size;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  focus(id: string): AgentActionResult {
    const record = this.elements.get(id);
    const el = record?.getElement();
    if (!el) return { ok: false, id, reason: "element not found" };
    el.focus();
    return { ok: true, id };
  }

  click(id: string): AgentActionResult {
    const record = this.elements.get(id);
    if (!record) return { ok: false, id, reason: "element not found" };
    if (!isClickable(record.descriptor)) {
      return { ok: false, id, reason: "element is not clickable" };
    }
    if (record.descriptor.onActivate) {
      record.descriptor.onActivate();
      return { ok: true, id };
    }
    const el = record.getElement();
    if (!el) return { ok: false, id, reason: "element not mounted" };
    el.click();
    return { ok: true, id };
  }

  fill(id: string, value: string): AgentActionResult {
    const record = this.elements.get(id);
    if (!record) return { ok: false, id, reason: "element not found" };
    if (!isFillable(record.descriptor)) {
      return { ok: false, id, reason: "element is not fillable" };
    }
    if (
      record.descriptor.options &&
      record.descriptor.options.length > 0 &&
      !record.descriptor.options.includes(value)
    ) {
      return {
        ok: false,
        id,
        reason: `value must be one of: ${record.descriptor.options.join(", ")}`,
      };
    }
    if (record.descriptor.onFill) {
      record.descriptor.onFill(value);
      return { ok: true, id, value };
    }
    const el = record.getElement();
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      setNativeFieldValue(el, value);
      return { ok: true, id, value };
    }
    return { ok: false, id, reason: "element is not a native field" };
  }

  scrollTo(id: string): AgentActionResult {
    const record = this.elements.get(id);
    const el = record?.getElement();
    if (!el) return { ok: false, id, reason: "element not found" };
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return { ok: true, id };
  }

  // ── highlight (agent indicator overlay) ────────────────────────────────────

  setHighlight(on: boolean): void {
    if (this.highlight === on) return;
    this.highlight = on;
    this.bump();
  }

  isHighlighting(): boolean {
    return this.highlight;
  }
}

// ── module-level map of live registries ─────────────────────────────────────

const viewRegistries = new Map<string, ViewAgentRegistry>();

function key(viewId: string, viewType: AgentViewType): string {
  return `${viewType}:${viewId}`;
}

export function getOrCreateViewRegistry(
  viewId: string,
  viewType: AgentViewType,
): ViewAgentRegistry {
  const k = key(viewId, viewType);
  let registry = viewRegistries.get(k);
  if (!registry) {
    registry = new ViewAgentRegistry(viewId, viewType);
    viewRegistries.set(k, registry);
  }
  return registry;
}

export function getViewRegistry(
  viewId: string,
  viewType: AgentViewType,
): ViewAgentRegistry | undefined {
  return viewRegistries.get(key(viewId, viewType));
}

export function removeViewRegistry(
  viewId: string,
  viewType: AgentViewType,
): void {
  viewRegistries.delete(key(viewId, viewType));
}
