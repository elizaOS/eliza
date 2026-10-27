/**
 * The views a product offers, under canonical ids. Product renderer keys and
 * older persisted ids resolve through the product registration only; no
 * caller keeps its own alias table.
 */
import type { ComponentType } from "react";
import {
  type MobileProductRegistration,
  mobileShellIconUrl,
} from "./product-registration";
import {
  isMobileShellViewId,
  MOBILE_SHELL_HOME_VIEW_ID,
  type MobileShellViewId,
} from "./view-ids";

export interface MobileViewProps {
  viewId: MobileShellViewId;
  /** Leaves the view the way Back does. */
  onClose: () => void;
}

export type MobileViewLoader = () => Promise<{
  default: ComponentType<MobileViewProps>;
}>;

export interface MobileViewRegistration {
  id: MobileShellViewId;
  label: string;
  /** The product renderer's own key when it predates the canonical id. */
  hostKey?: string;
  /** Lazy component for a view the shell renders itself. */
  loader?: MobileViewLoader;
  /** Navigable, but not offered on Home or in All apps. */
  hidden?: boolean;
}

/** What a host adds to a product view, or a view outside the product order. */
export interface MobileViewContribution {
  id: MobileShellViewId;
  /** Required for a view the product registration does not order. */
  label?: string;
  loader?: MobileViewLoader;
  hidden?: boolean;
}

export type MobileViewTarget =
  | { kind: "home" }
  | { kind: "view"; view: MobileViewRegistration };

export interface MobileViewRegistry {
  readonly product: MobileProductRegistration;
  /** Offered views in product order, filtered by current availability. */
  available(): MobileViewRegistration[];
  /** A registered view by canonical id, host key or older id. */
  find(name: string): MobileViewRegistration | undefined;
  /** The canonical id for any accepted name, including Home and served ids. */
  canonicalId(name: string): MobileShellViewId | undefined;
  /** Where navigation to `name` lands; undefined when it is not available. */
  target(name: string): MobileViewTarget | undefined;
  /** The product renderer key of a view. */
  hostKey(view: MobileViewRegistration): string;
  /** The view's entry key in the installed-app launcher. */
  launcherKey(view: MobileViewRegistration): string;
  fromLauncherKey(key: string): MobileViewRegistration | undefined;
  iconUrl(view: MobileViewRegistration): string | undefined;
}

/**
 * The product's ordered views with their labels and renderer keys, plus the
 * host's contributions (lazy components, hidden views, unordered views).
 */
export function createMobileViewRegistry(
  product: MobileProductRegistration,
  options: {
    views?: readonly MobileViewContribution[];
    available?: (view: MobileViewRegistration) => boolean;
  } = {},
): MobileViewRegistry {
  const byId = new Map<MobileShellViewId, MobileViewRegistration>();
  const byHostKey = new Map<string, MobileViewRegistration>();
  for (const id of product.views.order) {
    const hostKey = product.views.rendererKeys?.[id];
    const view: MobileViewRegistration = {
      id,
      label: product.views.labels[id] ?? id,
      ...(hostKey ? { hostKey } : {}),
    };
    byId.set(id, view);
    if (hostKey) byHostKey.set(hostKey, view);
  }
  const contributed = new Set<MobileShellViewId>();
  for (const { id, label, ...contribution } of options.views ?? []) {
    if (!isMobileShellViewId(id) || id === MOBILE_SHELL_HOME_VIEW_ID)
      throw new TypeError(`Not an app view id: ${String(id)}`);
    if (contributed.has(id))
      throw new TypeError(`View contributed twice: ${id}`);
    contributed.add(id);
    const known = byId.get(id);
    if (!known && !label?.trim())
      throw new TypeError(
        `View ${id} is not in the product order and needs a label`,
      );
    const view = {
      ...known,
      id,
      label: label ?? known?.label ?? id,
      ...contribution,
    };
    byId.set(id, view);
    if (view.hostKey) byHostKey.set(view.hostKey, view);
  }
  const owners = new Map<string, MobileShellViewId>();
  for (const [owner, ids] of Object.entries(product.views.serves ?? {}))
    for (const id of ids ?? []) owners.set(id, owner as MobileShellViewId);
  const order = [
    ...product.views.order,
    ...[...contributed].filter((id) => !product.views.order.includes(id)),
  ];
  const isAvailable = (view: MobileViewRegistration) =>
    options.available?.(view) ?? true;
  const prefix = product.storage.launcherBuiltinPrefix;

  const canonicalId = (name: string): MobileShellViewId | undefined => {
    if (isMobileShellViewId(name)) return name;
    const legacy = Object.hasOwn(product.views.legacyIds, name)
      ? product.views.legacyIds[name]
      : undefined;
    return legacy ?? byHostKey.get(name)?.id;
  };
  const find = (name: string) => {
    const id = canonicalId(name);
    return id ? byId.get(id) : undefined;
  };
  return {
    product,
    available: () =>
      order
        .map((id) => byId.get(id))
        .filter(
          (view): view is MobileViewRegistration =>
            !!view && !view.hidden && isAvailable(view),
        ),
    find,
    canonicalId,
    target(name) {
      const id = canonicalId(name);
      if (id === MOBILE_SHELL_HOME_VIEW_ID) return { kind: "home" };
      const view = id
        ? (byId.get(id) ?? byId.get(owners.get(id) ?? id))
        : undefined;
      return view && isAvailable(view) ? { kind: "view", view } : undefined;
    },
    hostKey: (view) => view.hostKey ?? view.id,
    launcherKey: (view) => `${prefix}${view.id}`,
    fromLauncherKey: (key) =>
      key.startsWith(prefix) && isMobileShellViewId(key.slice(prefix.length))
        ? byId.get(key.slice(prefix.length) as MobileShellViewId)
        : undefined,
    iconUrl(view) {
      const glyph = product.icons.views[view.id];
      return glyph ? mobileShellIconUrl(product, glyph) : undefined;
    },
  };
}
