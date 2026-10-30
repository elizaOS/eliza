/** A presentation projection of the authoritative app-shell page registry.
 * Product order, labels and icons never decide whether a page is available. */
import type { AppShellPageRegistration } from "../app-shell-pages";
import type {
  MobileLauncherRegistry,
  MobileLauncherView,
} from "./mobile-launcher";
import type { MobileProductRegistration } from "./product-registration";
import { mobileShellIconUrl } from "./product-registration";

export interface MobileApplicationPage extends MobileLauncherView {
  path: string;
  registration: AppShellPageRegistration;
}

export interface MobileApplicationCatalog
  extends MobileLauncherRegistry<MobileApplicationPage> {
  find(name: string): MobileApplicationPage | undefined;
  canonicalId(name: string): string | undefined;
}

export function createMobileApplicationCatalog(
  product: MobileProductRegistration,
  pages: () => readonly AppShellPageRegistration[],
  options: {
    /** Host runtime/permission admission, shared across product registrations. */
    available?: (page: AppShellPageRegistration) => boolean;
    iconUrl?: (page: AppShellPageRegistration) => string | undefined;
  } = {},
): MobileApplicationCatalog {
  const labels = new Map(Object.entries(product.views.labels));
  const icons = new Map(Object.entries(product.icons.views));
  const aliases = new Map<string, string>(
    Object.entries(product.views.legacyIds),
  );
  for (const [id, key] of Object.entries(product.views.rendererKeys ?? {}))
    if (key) aliases.set(key, id);
  const order = new Map(
    product.views.order.map((id, index) => [id as string, index]),
  );
  const cache = new WeakMap<AppShellPageRegistration, MobileApplicationPage>();
  const project = (
    registration: AppShellPageRegistration,
  ): MobileApplicationPage => {
    let page = cache.get(registration);
    if (!page) {
      const id = registration.agentViewId ?? registration.id;
      page = {
        id,
        label: labels.get(id) ?? registration.label,
        path: registration.path,
        registration,
      };
      cache.set(registration, page);
    }
    return page;
  };
  const current = () =>
    pages()
      .filter((page) => options.available?.(page) ?? true)
      .map(project);
  const find = (name: string) => {
    const available = current();
    // A legacy alias must not hide an admitted page that still uses that id.
    // Reverse lookup also preserves favorites already migrated by older hosts.
    const names = [
      name,
      aliases.get(name),
      ...[...aliases].flatMap(([from, to]) => (to === name ? [from] : [])),
    ];
    for (const id of names) {
      if (!id) continue;
      const page = available.find(
        (page) => page.id === id || page.registration.id === id,
      );
      if (page) return page;
    }
    return undefined;
  };
  const prefix = product.storage.launcherBuiltinPrefix;
  return {
    product,
    available: () =>
      current()
        .filter((page) => page.id !== "chat")
        .sort(
          (a, b) =>
            (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
            (a.registration.order ?? 100) - (b.registration.order ?? 100) ||
            a.label.localeCompare(b.label),
        ),
    find,
    canonicalId: (name) =>
      name === "home" || name === "chat" ? "chat" : find(name)?.id,
    hostKey: (page) => page.id,
    launcherKey: (page) => prefix + page.id,
    fromLauncherKey: (key) =>
      key.startsWith(prefix) ? find(key.slice(prefix.length)) : undefined,
    iconUrl: (page) => {
      const glyph = icons.get(page.id);
      return glyph
        ? mobileShellIconUrl(product, glyph)
        : options.iconUrl?.(page.registration);
    },
  };
}
