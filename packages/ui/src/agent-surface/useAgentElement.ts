/**
 * useAgentElement — register one element with the active view's agent surface.
 *
 * ```tsx
 * const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
 *   id: "send",
 *   role: "button",
 *   label: "Send transaction",
 *   onActivate: handleSend,
 * });
 * return <button ref={ref} {...agentProps} onClick={handleSend}>Send</button>;
 * ```
 *
 * The returned `ref` gives the registry a live handle to the DOM node, and
 * `agentProps` stamps `data-agent-*` / `data-state` so the element is both
 * machine-addressable and counted as a visual signal. Outside a view (no
 * provider) the hook is an inert no-op that still returns valid props.
 */

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { useAgentSurface } from "./AgentSurfaceContext.hooks";
import type { AgentElementDescriptor } from "./types";

export interface AgentElementHandle<T extends HTMLElement> {
  ref: RefObject<T | null>;
  agentProps: {
    "data-agent-id": string;
    "data-agent-role": string;
    "data-agent-label": string;
    "data-state"?: string;
  };
}

export function useAgentElement<T extends HTMLElement = HTMLElement>(
  descriptor: AgentElementDescriptor,
): AgentElementHandle<T> {
  const surface = useAgentSurface();
  const registry = surface?.registry ?? null;

  const elRef = useRef<T | null>(null);
  const latest = useRef<AgentElementDescriptor>(descriptor);
  latest.current = descriptor;

  // A stable descriptor whose data fields read through `latest` (getters) and
  // whose controlled handlers are wired only when the element actually supplies
  // them — so uncontrolled elements still fall through to DOM fill/click.
  const stableRef = useRef<AgentElementDescriptor | null>(null);
  if (!stableRef.current || stableRef.current.id !== descriptor.id) {
    const stable: AgentElementDescriptor = {
      id: descriptor.id,
      get label() {
        return latest.current.label;
      },
      get role() {
        return latest.current.role;
      },
      get group() {
        return latest.current.group;
      },
      get description() {
        return latest.current.description;
      },
      get status() {
        return latest.current.status;
      },
      get order() {
        return latest.current.order;
      },
      get fillable() {
        return latest.current.fillable;
      },
      get clickable() {
        return latest.current.clickable;
      },
      get options() {
        return latest.current.options;
      },
    };
    if (descriptor.getValue) {
      stable.getValue = () => latest.current.getValue?.();
    }
    if (descriptor.onFill) {
      stable.onFill = (value: string) => latest.current.onFill?.(value);
    }
    if (descriptor.onActivate) {
      stable.onActivate = () => latest.current.onActivate?.();
    }
    stableRef.current = stable;
  }

  // Register/unregister with the registry across the element's lifetime.
  useEffect(() => {
    const stable = stableRef.current;
    if (!registry || !stable) return;
    return registry.register(stable, () => elRef.current);
  }, [registry]);

  // Notify subscribers (the indicator overlay) when rendered fields change.
  // The descriptor fields are intentional deps: the live getters mean the
  // registry already sees fresh values, but subscribers only re-read on a bump.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive the version bump
  useEffect(() => {
    registry?.touch();
  }, [registry, descriptor.label, descriptor.status, descriptor.role]);

  return {
    ref: elRef,
    agentProps: {
      "data-agent-id": descriptor.id,
      "data-agent-role": descriptor.role ?? "region",
      "data-agent-label": descriptor.label,
      ...(descriptor.status ? { "data-state": descriptor.status } : {}),
    },
  };
}
