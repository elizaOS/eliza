/**
 * ShopifySpatialView - the Shopify store dashboard authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus type-only views of
 * the dashboard data shapes, so it is safe to render in the Node agent process
 * where the terminal lives (no React-DOM / browser runtime import).
 *
 * GUI Tabs map to spatial sections: the dashboard shows a counts strip
 * (overview) and one focused commerce section per active tab. On every surface
 * tab selection is a row of `Button`s; the host swaps `snapshot.tab` and
 * re-renders, so the same authored view drives GUI tab clicks, XR spatial
 * selection, and TUI grid sections from one source of truth.
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";
import type {
  ShopifyCustomer,
  ShopifyInventoryItem,
  ShopifyOrder,
  ShopifyProduct,
  ShopifyStatus,
} from "../useShopifyDashboard.ts";

export type ShopifyTab =
  | "overview"
  | "products"
  | "orders"
  | "inventory"
  | "customers";

export interface ShopifySnapshot {
  status: ShopifyStatus | null;
  tab: ShopifyTab;
  counts: { productCount: number; orderCount: number; customerCount: number };
  products: ShopifyProduct[];
  productsTotal: number;
  productsPage: number;
  productSearch: string;
  orders: ShopifyOrder[];
  ordersTotal: number;
  orderStatusFilter: string;
  inventoryItems: ShopifyInventoryItem[];
  inventoryLocations: string[];
  customers: ShopifyCustomer[];
  customersTotal: number;
  customerSearch: string;
  loading?: boolean;
  error?: string | null;
}

const TABS: { id: ShopifyTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "products", label: "Products" },
  { id: "orders", label: "Orders" },
  { id: "inventory", label: "Inventory" },
  { id: "customers", label: "Customers" },
];

function financialTone(status: ShopifyOrder["financialStatus"]): SpatialTone {
  switch (status) {
    case "PAID":
      return "success";
    case "PENDING":
      return "warning";
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "danger";
    default:
      return "muted";
  }
}

function productStatusTone(status: ShopifyProduct["status"]): SpatialTone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "DRAFT":
      return "warning";
    default:
      return "muted";
  }
}

function inventoryTone(available: number): SpatialTone {
  if (available === 0) return "danger";
  if (available <= 5) return "warning";
  return "default";
}

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: SpatialTone;
}) {
  // Borderless stat block — sections use the outer frame + dividers, not nested boxes.
  return (
    <VStack gap={0} grow={1}>
      <Text style="subheading" tone={tone} bold>
        {value.toLocaleString()}
      </Text>
      <Text style="caption" tone="muted">
        {label}
      </Text>
    </VStack>
  );
}

function OverviewSection({ snapshot }: { snapshot: ShopifySnapshot }) {
  const lowInventory = snapshot.inventoryItems.filter(
    (item) => item.available <= 5,
  );
  const urgent = lowInventory.filter((item) => item.available === 0).length;
  return (
    <VStack gap={1} width="100%">
      <HStack gap={1} wrap width="100%">
        <CountTile
          label="Products"
          value={snapshot.counts.productCount}
          tone="primary"
        />
        <CountTile
          label="Orders"
          value={snapshot.counts.orderCount}
          tone="success"
        />
        <CountTile
          label="Low stock"
          value={lowInventory.length}
          tone={urgent > 0 ? "danger" : "warning"}
        />
        <CountTile
          label="Customers"
          value={snapshot.counts.customerCount}
          tone="muted"
        />
      </HStack>

      <Divider label="recent orders" />
      {snapshot.orders.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No recent orders
        </Text>
      ) : (
        <List gap={0} width="100%">
          {snapshot.orders.slice(0, 3).map((order) => (
            <HStack key={order.id} gap={1} align="center" width="100%">
              <Text bold wrap={false} width={9}>
                {order.name}
              </Text>
              <Text style="caption" tone="muted" grow={1} wrap={false}>
                {order.email || "guest"}
              </Text>
              <Text wrap={false}>
                {order.totalPrice} {order.currencyCode}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="low inventory" />
      {lowInventory.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          Stock levels look good
        </Text>
      ) : (
        <List gap={0} width="100%">
          {lowInventory.slice(0, 3).map((item) => (
            <HStack
              key={`${item.id}:${item.locationName}`}
              gap={1}
              align="center"
              width="100%"
            >
              <Text grow={1} wrap={false}>
                {item.productTitle}
                {item.variantTitle ? ` / ${item.variantTitle}` : ""}
              </Text>
              <Text tone={inventoryTone(item.available)} bold>
                {item.available}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </VStack>
  );
}

function ProductsSection({ snapshot }: { snapshot: ShopifySnapshot }) {
  return (
    <VStack gap={1} width="100%">
      <Text style="caption" tone="muted">
        {snapshot.productSearch
          ? `search "${snapshot.productSearch}"`
          : "all products"}{" "}
        | page {snapshot.productsPage} | {snapshot.productsTotal} total
      </Text>
      {snapshot.products.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No products
        </Text>
      ) : (
        <List gap={0} width="100%">
          {snapshot.products.slice(0, 6).map((product) => (
            <HStack key={product.id} gap={1} align="center" width="100%">
              <Text tone={productStatusTone(product.status)}>
                {product.status === "ACTIVE"
                  ? "+"
                  : product.status === "DRAFT"
                    ? "."
                    : "x"}
              </Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {product.title}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {product.vendor || product.productType || "uncategorized"}
                </Text>
              </VStack>
              <Text wrap={false}>
                {product.priceRange.min === product.priceRange.max
                  ? product.priceRange.min
                  : `${product.priceRange.min}-${product.priceRange.max}`}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </VStack>
  );
}

function OrdersSection({ snapshot }: { snapshot: ShopifySnapshot }) {
  return (
    <VStack gap={1} width="100%">
      <Text style="caption" tone="muted">
        filter {snapshot.orderStatusFilter} | {snapshot.ordersTotal} total
      </Text>
      {snapshot.orders.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No orders
        </Text>
      ) : (
        <List gap={0} width="100%">
          {snapshot.orders.slice(0, 6).map((order) => (
            <HStack key={order.id} gap={1} align="center" width="100%">
              <Text bold wrap={false} width={9}>
                {order.name}
              </Text>
              <Text
                style="caption"
                tone={financialTone(order.financialStatus)}
                wrap={false}
                grow={1}
              >
                {order.financialStatus.toLowerCase()}
              </Text>
              <Text wrap={false}>
                {order.totalPrice} {order.currencyCode}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </VStack>
  );
}

function InventorySection({ snapshot }: { snapshot: ShopifySnapshot }) {
  return (
    <VStack gap={1} width="100%">
      <Text style="caption" tone="muted">
        {snapshot.inventoryItems.length} rows |{" "}
        {snapshot.inventoryLocations.length} locations
      </Text>
      {snapshot.inventoryItems.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No inventory
        </Text>
      ) : (
        <List gap={0} width="100%">
          {snapshot.inventoryItems.slice(0, 6).map((item) => (
            <HStack
              key={`${item.id}:${item.locationName}`}
              gap={1}
              align="center"
              width="100%"
            >
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {item.productTitle}
                  {item.variantTitle ? ` / ${item.variantTitle}` : ""}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {item.locationName}
                </Text>
              </VStack>
              <Text tone={inventoryTone(item.available)} bold>
                {item.available}
              </Text>
              <Text style="caption" tone="muted">
                +{item.incoming}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </VStack>
  );
}

function CustomersSection({ snapshot }: { snapshot: ShopifySnapshot }) {
  return (
    <VStack gap={1} width="100%">
      <Text style="caption" tone="muted">
        {snapshot.customerSearch
          ? `search "${snapshot.customerSearch}"`
          : "all customers"}{" "}
        | {snapshot.customersTotal} total
      </Text>
      {snapshot.customers.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No customers
        </Text>
      ) : (
        <List gap={0} width="100%">
          {snapshot.customers.slice(0, 6).map((customer) => (
            <HStack key={customer.id} gap={1} align="center" width="100%">
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {`${customer.firstName} ${customer.lastName}`.trim() ||
                    customer.email ||
                    "Customer"}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {customer.email}
                </Text>
              </VStack>
              <Text style="caption" tone="muted" wrap={false}>
                {customer.ordersCount} orders
              </Text>
              <Text wrap={false}>
                {customer.totalSpent} {customer.currencyCode}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </VStack>
  );
}

function Section({ snapshot }: { snapshot: ShopifySnapshot }) {
  switch (snapshot.tab) {
    case "products":
      return <ProductsSection snapshot={snapshot} />;
    case "orders":
      return <OrdersSection snapshot={snapshot} />;
    case "inventory":
      return <InventorySection snapshot={snapshot} />;
    case "customers":
      return <CustomersSection snapshot={snapshot} />;
    default:
      return <OverviewSection snapshot={snapshot} />;
  }
}

export interface ShopifySpatialViewProps {
  snapshot: ShopifySnapshot;
  /** Dispatch by agent id: `tab:<id>`, `refresh`. */
  onAction?: (action: string) => void;
}

export function ShopifySpatialView({
  snapshot,
  onAction,
}: ShopifySpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const connected = snapshot.status?.connected ?? false;
  const shop = snapshot.status?.shop ?? null;

  return (
    <Card title="Shopify" gap={1} padding={1}>
      <HStack gap={1} align="center" width="100%">
        <Text
          style="caption"
          tone={connected ? "success" : "danger"}
          wrap={false}
        >
          {connected ? "connected" : "offline"}
        </Text>
        <Text style="caption" tone="muted" grow={1} align="end" wrap={false}>
          {snapshot.loading ? "loading" : (shop?.name ?? "no shop")}
        </Text>
      </HStack>
      <Text style="caption" tone="muted" width="100%" wrap={false}>
        {shop?.domain ?? "no domain"}
      </Text>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      {!connected && !snapshot.loading ? (
        <Text tone="muted" style="caption">
          Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN for live data.
        </Text>
      ) : null}

      <HStack gap={1} wrap width="100%">
        {TABS.map((tab) => (
          <Button
            key={tab.id}
            variant={snapshot.tab === tab.id ? "solid" : "outline"}
            tone={snapshot.tab === tab.id ? "primary" : "default"}
            agent={`tab-${tab.id}`}
            onPress={dispatch(`tab:${tab.id}`)}
          >
            {tab.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          tone="default"
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
      </HStack>

      <Divider label={snapshot.tab} />
      <Section snapshot={snapshot} />
    </Card>
  );
}
