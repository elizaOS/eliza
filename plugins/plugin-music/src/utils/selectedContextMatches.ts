/**
 * Context-selection predicate shared by music action validators.
 *
 * The planner and older callers expose selected contexts through different
 * state slots, so this helper keeps action routing consistent without each
 * handler duplicating the compatibility scan.
 */
import { CONTEXT_ROUTING_STATE_KEY, type State } from "@elizaos/core";

interface ContextRoutingState {
  primaryContext?: unknown;
  secondaryContexts?: unknown;
}

interface SelectedContextOptions {
  includeContextRouting?: boolean;
}

export function selectedContextMatches(
  state: State | undefined,
  contexts: readonly string[],
  options: SelectedContextOptions = {},
): boolean {
  const selected = new Set<string>();
  const collectOne = (value: unknown) => {
    if (typeof value === "string") selected.add(value);
  };
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) collectOne(item);
  };

  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );

  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);

  // The planner stores action-exposure routing here, not in selectedContexts.
  if (options.includeContextRouting) {
    const routing = (state?.values as Record<string, unknown> | undefined)?.[
      CONTEXT_ROUTING_STATE_KEY
    ] as ContextRoutingState | undefined;
    collectOne(routing?.primaryContext);
    collect(routing?.secondaryContexts);
  }

  return contexts.some((context) => selected.has(context));
}
