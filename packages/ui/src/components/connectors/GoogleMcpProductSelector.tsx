/**
 * Accessible multi-select for the official personal Google Workspace MCP
 * products. The full label row is clickable and selection is kept outside the
 * component so OAuth and existing-account binding flows can share it.
 */

import type { GoogleWorkspaceMcpProduct } from "@elizaos/shared/contracts";
import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { PERSONAL_GOOGLE_MCP_PRODUCTS } from "./google-mcp-products";

export interface GoogleMcpProductSelectorProps {
  selectedProducts: readonly GoogleWorkspaceMcpProduct[];
  lockedProducts?: readonly GoogleWorkspaceMcpProduct[];
  onChange: (products: GoogleWorkspaceMcpProduct[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}

export function GoogleMcpProductSelector({
  selectedProducts,
  lockedProducts = [],
  onChange,
  disabled = false,
  idPrefix = "google-mcp-product",
}: GoogleMcpProductSelectorProps) {
  const selected = new Set(selectedProducts);
  const locked = new Set(lockedProducts);

  const update = (product: GoogleWorkspaceMcpProduct, checked: boolean) => {
    if (locked.has(product)) return;
    const next = new Set([...selected, ...locked]);
    if (checked) next.add(product);
    else next.delete(product);
    onChange(
      PERSONAL_GOOGLE_MCP_PRODUCTS.map((option) => option.id).filter((id) =>
        next.has(id),
      ),
    );
  };

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        Google products
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {PERSONAL_GOOGLE_MCP_PRODUCTS.map((product) => {
          const id = `${idPrefix}-${product.id}`;
          const isLocked = locked.has(product.id);
          return (
            <label
              key={product.id}
              htmlFor={id}
              className={cn(
                "flex min-h-touch items-start gap-3 rounded-sm border p-3 transition-colors",
                isLocked
                  ? "cursor-not-allowed border-border/50 bg-card/35"
                  : "cursor-pointer border-border/50 bg-card/35 hover:border-accent/45 hover:bg-bg-hover",
              )}
            >
              <Checkbox
                id={id}
                checked={selected.has(product.id) || isLocked}
                disabled={isLocked}
                onCheckedChange={(checked) =>
                  update(product.id, checked === true)
                }
                className="mt-0.5"
              />
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium text-txt-strong">
                  {product.label}
                </span>
                <span className="block text-xs leading-relaxed text-muted">
                  {product.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {selectedProducts.length === 0 && lockedProducts.length === 0 ? (
        <p role="alert" className="text-xs text-warn">
          Select at least one Google product.
        </p>
      ) : null}
    </fieldset>
  );
}
