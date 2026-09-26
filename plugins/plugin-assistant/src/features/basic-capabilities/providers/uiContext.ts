/**
 * UI_CONTEXT provider — surfaces which Eliza UI surface (view and tab) sent the
 * current message and the capability contexts forced active for this turn, so
 * the planner prefers actions and providers matching that context first. Stays
 * silent when there is neither a UI view nor an active routing context. Part of
 * the basic-capabilities bundle.
 */

import type { Memory, Provider, State } from "@elizaos/core";
import {
  asRecord,
  CONTEXT_ROUTING_METADATA_KEY,
  CONTEXT_ROUTING_STATE_KEY,
  getActiveRoutingContexts,
  parseContextRoutingMetadata,
} from "@elizaos/core";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = asString(entry);
    return parsed ? [parsed] : [];
  });
}

export const uiContextProvider: Provider = {
  name: "UI_CONTEXT",
  description:
    "Eliza UI surface that sent the current message and the forced capability context for this turn.",
  position: -10,
  contexts: ["general"],
  contextGate: { anyOf: ["general"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (_runtime, message: Memory, state: State) => {
    const metadata = asRecord(message.content.metadata);
    const uiView = asString(metadata?.uiView);
    const uiTab = asString(metadata?.uiTab);
    const uiViewSubview = asString(metadata?.uiViewSubview);
    const uiViewPath = asString(metadata?.uiViewPath);
    const uiViewCapabilities = asStringList(metadata?.uiViewCapabilities);
    const uiViewActionNames = asStringList(metadata?.uiViewActionNames);
    const routing = parseContextRoutingMetadata(
      metadata?.[CONTEXT_ROUTING_METADATA_KEY] ??
        state.values[CONTEXT_ROUTING_STATE_KEY],
    );
    const activeContexts = getActiveRoutingContexts(routing);

    if (!uiView && activeContexts.length === 0) {
      return { text: "", values: {}, data: {} };
    }

    const lines = [
      "# UI Context",
      `view: ${uiView ?? "chat"}`,
      uiTab ? `tab: ${uiTab}` : null,
      uiViewSubview ? `subview_id: ${uiViewSubview}` : null,
      uiViewPath ? `path: ${uiViewPath}` : null,
      uiViewCapabilities.length > 0
        ? `view_capabilities: ${uiViewCapabilities.join(", ")}`
        : null,
      uiViewActionNames.length > 0
        ? `view_actions: ${uiViewActionNames.join(", ")}`
        : null,
      `active_contexts: ${activeContexts.join(", ") || "general"}`,
      "view_capabilities is context, not an invocation request.",
      "Current-turn view identity can answer which view is open now; historical navigation receipts establish earlier delivery. Only view identity/capabilities are supplied, not displayed content or current record values. View/subview IDs are routing identifiers, not necessarily titles. For displayed text, balances, selections or current settings, use an available registered scoped action that reads the needed view state or a relevant domain read action. Capability names and element IDs are not standalone tools; invoke only operations exposed by registered actions. Never infer displayed values from routes or configuration diagnostics.",
      "Discover views with VIEWS_LIST or VIEWS list; open with VIEWS_SHOW or VIEWS show when registered. Opening is not a record operation. Use note/event actions only for requested record reads/writes, preferring available child actions over umbrellas. Use registered scoped actions for supported view controls; do not infer additional VIEWS operations from view capabilities. Claim effects only from successful results.",
    ].filter((line): line is string => line !== null);

    return {
      text: lines.join("\n"),
      values: {
        uiView: uiView ?? "chat",
        uiTab: uiTab ?? "",
        uiViewSubview: uiViewSubview ?? "",
        uiViewPath: uiViewPath ?? "",
        uiViewCapabilities: uiViewCapabilities.join(", "),
        uiViewActionNames: uiViewActionNames.join(", "),
        uiContexts: activeContexts.join(", "),
      },
      data: {
        uiView,
        uiTab,
        uiViewSubview,
        uiViewPath,
        uiViewCapabilities,
        uiViewActionNames,
        activeContexts,
      },
    };
  },
};
