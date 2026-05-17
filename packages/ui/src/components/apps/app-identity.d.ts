import { type LucideIcon } from "lucide-react";
export interface AppIdentitySource {
  name: string;
  displayName?: string | null;
  category?: string | null;
  icon?: string | null;
  heroImage?: string | null;
  description?: string | null;
}
export declare function iconImageSource(
  icon: string | null | undefined,
): string | null;
/**
 * Convert a heroImage/icon src into a runtime-safe URL.
 *
 * Root-relative paths fail under non-http origins (electrobun://, file://)
 * because the page origin isn't the static asset host. Route them through
 * the appropriate runtime resolver so they hit the API/asset base instead.
 */
export declare function resolveRuntimeImageUrl(value: string): string;
export declare function getAppCategoryIcon(app: AppIdentitySource): LucideIcon;
export declare function AppIdentityTile({
  app,
  active,
  className,
  size,
  imageOnly,
}: {
  app: AppIdentitySource;
  active?: boolean;
  className?: string;
  size?: "sm" | "md";
  imageOnly?: boolean;
}): import("react/jsx-runtime").JSX.Element;
export declare function AppHero({
  app,
  className,
  imageOnly,
}: {
  app: AppIdentitySource;
  className?: string;
  imageOnly?: boolean;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=app-identity.d.ts.map
