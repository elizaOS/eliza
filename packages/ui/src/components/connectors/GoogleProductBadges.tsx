/**
 * Badge list for a connector account's selected Google Workspace MCP products,
 * shared by the Cloud agent connector section and the connector account card
 * so both render the contract's human-readable product labels.
 */

import {
  canonicalGoogleMcpProduct,
  GOOGLE_WORKSPACE_MCP_PRODUCT_LABELS,
} from "@elizaos/shared/contracts";
import { Badge } from "../ui/badge";

/** Contract label for a stored product id; unknown ids render verbatim. */
export function googleMcpProductLabel(product: string): string {
  const canonical = canonicalGoogleMcpProduct(product);
  return canonical ? GOOGLE_WORKSPACE_MCP_PRODUCT_LABELS[canonical] : product;
}

export function GoogleProductBadgeList({
  products,
  ariaLabel,
  variant,
}: {
  products: readonly string[];
  ariaLabel: string;
  variant: "outline" | "secondary";
}) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={ariaLabel}>
      {products.map((product) => (
        <li key={product}>
          <Badge variant={variant} className="text-[10px]">
            {googleMcpProductLabel(product)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
