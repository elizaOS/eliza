/**
 * Register the Shopify view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the Shopify `viewType: "tui"` declaration render for real
 * in the terminal (the unified {@link ShopifySpatialView}) rather than only
 * navigating a GUI shell. A module-level snapshot lets a host push live store
 * data; with no live store it defaults to the offline overview.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type ShopifySnapshot,
  ShopifySpatialView,
} from "./components/ShopifySpatialView.tsx";

const EMPTY: ShopifySnapshot = {
  status: { connected: false, shop: null },
  tab: "overview",
  counts: { productCount: 0, orderCount: 0, customerCount: 0 },
  products: [],
  productsTotal: 0,
  productsPage: 1,
  productSearch: "",
  orders: [],
  ordersTotal: 0,
  orderStatusFilter: "any",
  inventoryItems: [],
  inventoryLocations: [],
  customers: [],
  customersTotal: 0,
  customerSearch: "",
};

let current: ShopifySnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setShopifyTerminalSnapshot(next: ShopifySnapshot): void {
  current = next;
}

/** Register the Shopify terminal view; returns an unregister function. */
export function registerShopifyTerminalView(): () => void {
  return registerSpatialTerminalView("shopify", () =>
    createElement(ShopifySpatialView, { snapshot: current }),
  );
}
