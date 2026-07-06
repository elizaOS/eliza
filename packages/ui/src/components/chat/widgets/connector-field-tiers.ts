/**
 * Splits a connector/plugin's parameter schema into the two progressive-
 * disclosure tiers the connector-setup widget renders: `minimal` (shown by
 * default) and `advanced` (behind an "Advanced" dropdown). This is the single
 * place that decides which fields a user sees up front, so the connector widget
 * and its tests agree on one derivation.
 *
 * Rule: a param is minimal when it is `required` OR not yet set (`isSet` is
 * falsy) — i.e. the fields a user must touch to get connected. Everything the
 * schema already has a value for and does not require is advanced. `completed`
 * folds the same schema into the shell's collapse decision: complete once every
 * required param is set.
 *
 * Consumed by `connector-setup-widget.tsx`; kept as a pure module (no React) so
 * the tiering is unit-testable without mounting the widget graph.
 */
import type { PluginParam } from "@elizaos/shared";

export interface ConnectorFieldTiers {
  minimal: PluginParam[];
  advanced: PluginParam[];
}

/** Partition params into minimal (required/unset) vs advanced (set optionals). */
export function deriveConnectorFieldTiers(
  params: PluginParam[],
): ConnectorFieldTiers {
  const minimal: PluginParam[] = [];
  const advanced: PluginParam[] = [];
  for (const param of params) {
    if (param.required || !param.isSet) {
      minimal.push(param);
    } else {
      advanced.push(param);
    }
  }
  return { minimal, advanced };
}

/** A connector is complete once every required param has a value set. */
export function isConnectorConfigured(params: PluginParam[]): boolean {
  return params.every((param) => !param.required || Boolean(param.isSet));
}
