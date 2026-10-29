/**
 * The functional feature manifest of one branded mobile product, emitted from
 * its registration. Branded builds of the shared shell must report the same
 * functional part; identity, theme, labels, icons and installed storage names
 * are the only per-product differences. `compareMobileFeatureManifests` names
 * every functional difference so a product's parity gate can fail on it.
 */
import type {
  MobileProductRegistration,
  MobileShellAppearance,
} from "./product-registration";
import type { MobileShellViewId } from "./view-ids";

export const MOBILE_FEATURE_MANIFEST_SCHEMA = "elizaos.mobile-feature-manifest";
export const MOBILE_FEATURE_MANIFEST_SCHEMA_VERSION = 1;

/** One view the product offers, with the canonical ids it also serves. */
export interface MobileFeatureView {
  id: MobileShellViewId;
  serves: MobileShellViewId[];
}

/** What a product does: identical across brands of one shared application. */
export interface MobileFeatureFunctional {
  /** Offered views, sorted by id (Home order is presentation). */
  views: MobileFeatureView[];
  /** Device and shell capabilities, sorted. */
  capabilities: string[];
  /** Canonical agent and device action names, sorted. */
  actions: string[];
}

/** How a product looks and which installed identifiers it keeps. */
export interface MobileFeatureBranding {
  appName: string;
  appId: string;
  characterName: string;
  revision: number;
  themeId: string;
  defaultAppearance: MobileShellAppearance | "system";
  order: MobileShellViewId[];
  labels: Partial<Record<MobileShellViewId, string>>;
  icons: Partial<Record<MobileShellViewId, string>>;
  storage: {
    launcherFavorites: string;
    launcherBuiltinPrefix: string;
    launcherDefaultPolicy: string;
    retained: Record<string, string>;
  };
  legacyIds: Record<string, MobileShellViewId>;
}

export interface MobileFeatureManifest {
  schema: typeof MOBILE_FEATURE_MANIFEST_SCHEMA;
  schemaVersion: typeof MOBILE_FEATURE_MANIFEST_SCHEMA_VERSION;
  branding: MobileFeatureBranding;
  functional: MobileFeatureFunctional;
}

const sorted = <T extends string>(values: Iterable<T>): T[] =>
  [...new Set(values)].sort();

const sortedRecord = <V>(
  value: Readonly<Record<string, V | undefined>> | undefined,
): Record<string, V> =>
  Object.fromEntries(
    Object.entries(value ?? {})
      .filter((entry): entry is [string, V] => entry[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/**
 * The manifest of a registration. Deterministic: the same record always
 * emits the same JSON, so a checked-in snapshot can gate changes.
 */
export function mobileFeatureManifest(
  product: MobileProductRegistration,
): MobileFeatureManifest {
  const serves = product.views.serves ?? {};
  return {
    schema: MOBILE_FEATURE_MANIFEST_SCHEMA,
    schemaVersion: MOBILE_FEATURE_MANIFEST_SCHEMA_VERSION,
    branding: {
      appName: product.identity.appName,
      appId: product.identity.appId,
      characterName: product.identity.characterName,
      revision: product.revision,
      themeId: product.theme.id,
      defaultAppearance: product.theme.defaultAppearance,
      order: [...product.views.order],
      labels: sortedRecord(product.views.labels),
      icons: sortedRecord(product.icons.views),
      storage: {
        launcherFavorites: product.storage.launcherFavorites,
        launcherBuiltinPrefix: product.storage.launcherBuiltinPrefix,
        launcherDefaultPolicy: product.storage.launcherDefaultPolicy,
        retained: sortedRecord(product.storage.retained),
      },
      legacyIds: sortedRecord(product.views.legacyIds),
    },
    functional: {
      views: sorted(product.views.order).map((id) => ({
        id,
        serves: sorted(serves[id] ?? []),
      })),
      capabilities: sorted(product.features?.capabilities ?? []),
      actions: sorted(product.features?.actions ?? []),
    },
  };
}

export type MobileFeatureKind = "view" | "serves" | "capability" | "action";

/** One functional difference: `only` names the manifest that has the feature. */
export interface MobileFeatureDifference {
  kind: MobileFeatureKind;
  /** View id, `<view>:<served id>`, capability or action name. */
  name: string;
  only: "a" | "b";
}

/**
 * Every functional difference between two manifests, in a stable order.
 * Branding never counts. Empty when the two products are functionally equal.
 */
export function compareMobileFeatureManifests(
  a: MobileFeatureManifest,
  b: MobileFeatureManifest,
): MobileFeatureDifference[] {
  const differences: MobileFeatureDifference[] = [];
  const diff = (
    kind: MobileFeatureKind,
    left: readonly string[],
    right: readonly string[],
  ) => {
    const inLeft = new Set(left);
    const inRight = new Set(right);
    for (const name of sorted([...left, ...right])) {
      if (inLeft.has(name) && !inRight.has(name))
        differences.push({ kind, name, only: "a" });
      else if (inRight.has(name) && !inLeft.has(name))
        differences.push({ kind, name, only: "b" });
    }
  };
  const servedPairs = (manifest: MobileFeatureManifest) =>
    manifest.functional.views.flatMap((view) =>
      view.serves.map((id) => `${view.id}:${id}`),
    );
  diff(
    "view",
    a.functional.views.map((view) => view.id),
    b.functional.views.map((view) => view.id),
  );
  diff("serves", servedPairs(a), servedPairs(b));
  diff("capability", a.functional.capabilities, b.functional.capabilities);
  diff("action", a.functional.actions, b.functional.actions);
  return differences;
}

/** Stable text of one difference, for allowlists and failure messages. */
export function mobileFeatureDifferenceKey(
  difference: MobileFeatureDifference,
): string {
  return `${difference.kind}:${difference.name}:only-${difference.only}`;
}
