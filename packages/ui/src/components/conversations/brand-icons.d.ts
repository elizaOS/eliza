import type * as React from "react";

type BrandIconProps = {
  className?: string;
};
/**
 * Look up a brand icon by a free-form source string (plugin id, display name,
 * etc). Normalizes by stripping non-alphanumeric characters so `"google-chat"`,
 * `"Google Chat"`, and `"googlechat"` all resolve to the same icon.
 */
export declare function getBrandIcon(
  source: string,
): React.ComponentType<BrandIconProps> | null;
//# sourceMappingURL=brand-icons.d.ts.map
