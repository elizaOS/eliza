import { Button, Skeleton } from "@elizaos/ui";
import { Minus, Package, Plus } from "lucide-react";
import { useState } from "react";
import type { ShopifyInventoryItem } from "./useShopifyDashboard";

interface InventoryRowProps {
  item: ShopifyInventoryItem;
  onAdjust: (
    itemId: string,
    locationId: string | null,
    delta: number,
  ) => Promise<void>;
}

function InventoryRow({ item, onAdjust }: InventoryRowProps) {
  const [adjusting, setAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [localAvailable, setLocalAvailable] = useState(item.available);

  async function handleAdjust(delta: number) {
    setAdjusting(true);
    setAdjustError(null);
    try {
      await onAdjust(item.id, item.locationId, delta);
      setLocalAvailable((prev) => prev + delta);
    } catch (err) {
      setAdjustError(err instanceof Error ? err.message : "Adjustment failed.");
    } finally {
      setAdjusting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/20 bg-card/30 px-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-txt">
          {item.productTitle}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs-tight text-muted">
          {item.variantTitle ? <span>{item.variantTitle}</span> : null}
          {item.sku ? (
            <>
              {item.variantTitle ? <span>·</span> : null}
              <span className="font-mono">{item.sku}</span>
            </>
          ) : null}
        </div>
        {adjustError ? (
          <div className="mt-1 text-xs-tight text-danger">{adjustError}</div>
        ) : null}
      </div>

      <div
        className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-txt"
        title="Available"
      >
        <Package className="h-3.5 w-3.5 text-muted" aria-hidden />
        {localAvailable.toLocaleString()}
      </div>

      <div
        className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-txt"
        title="Incoming"
      >
        <Plus className="h-3.5 w-3.5 text-muted" aria-hidden />
        {item.incoming.toLocaleString()}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          disabled={adjusting}
          onClick={() => void handleAdjust(-1)}
          aria-label="Decrease inventory by 1"
        >
          <Minus className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          disabled={adjusting}
          onClick={() => void handleAdjust(1)}
          aria-label="Increase inventory by 1"
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

interface InventoryLevelsPanelProps {
  items: ShopifyInventoryItem[];
  locations: string[];
  loading: boolean;
  error: string | null;
}

export function InventoryLevelsPanel({
  items,
  locations,
  loading,
  error,
}: InventoryLevelsPanelProps) {
  const [selectedLocation, setSelectedLocation] = useState<string>("all");

  const displayedItems =
    selectedLocation === "all"
      ? items
      : items.filter((item) => item.locationName === selectedLocation);

  async function handleAdjust(
    itemId: string,
    locationId: string | null,
    delta: number,
  ): Promise<void> {
    const res = await fetch(`/api/shopify/inventory/${itemId}/adjust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta, locationId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      throw new Error(text);
    }
  }

  return (
    <div className="space-y-3">
      {locations.length > 0 ? (
        <div className="flex items-center gap-2">
          <label
            className="shrink-0 text-xs font-semibold text-muted-strong"
            htmlFor="inventory-location"
          >
            Location
          </label>
          <select
            id="inventory-location"
            value={selectedLocation}
            onChange={(e) => setSelectedLocation(e.target.value)}
            className="flex h-10 w-full max-w-xs rounded-md border border-input bg-bg px-3 py-2 text-sm ring-offset-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="all">All locations</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">
            {displayedItems.length} item{displayedItems.length !== 1 ? "s" : ""}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => i).map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : displayedItems.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/20 bg-card/20 py-12 text-center">
          <Package className="h-8 w-8 text-muted/40" />
          <div className="text-sm text-muted">
            {selectedLocation === "all"
              ? "No inventory items found."
              : `No items at ${selectedLocation}.`}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {displayedItems.map((item) => (
            <InventoryRow
              key={`${item.id}:${item.locationName}`}
              item={item}
              onAdjust={handleAdjust}
            />
          ))}
        </div>
      )}
    </div>
  );
}
