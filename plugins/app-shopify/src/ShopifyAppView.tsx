import type { OverlayAppContext } from "@elizaos/ui";
import {
  Badge,
  Button,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@elizaos/ui";
import {
  BarChart3,
  ChevronLeft,
  Globe2,
  KeyRound,
  Package,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Store,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useState } from "react";
import { CustomersPanel } from "./CustomersPanel";
import { InventoryLevelsPanel } from "./InventoryLevelsPanel";
import { OrdersPanel } from "./OrdersPanel";
import { ProductsPanel } from "./ProductsPanel";
import { StoreOverviewCard } from "./StoreOverviewCard";
import { useShopifyDashboard } from "./useShopifyDashboard";

function ShopifySetupCard() {
  const setupItems = [
    { label: "Domain", value: "STORE_DOMAIN", icon: Globe2, tone: "text-info" },
    { label: "Token", value: "ACCESS_TOKEN", icon: KeyRound, tone: "text-warning" },
    { label: "Scopes", value: "read_*", icon: ShieldCheck, tone: "text-ok" },
  ] as const;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="rounded-2xl border border-border/30 bg-card/40 px-5 py-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-ok/25 bg-ok/12">
            <Store className="h-7 w-7 text-ok" />
          </div>
          <div className="text-lg font-semibold text-txt">
            Connect Shopify
          </div>

          <div className="grid w-full gap-2 sm:grid-cols-3">
            {setupItems.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.label}
                  className="rounded-xl border border-border/24 bg-bg/50 px-3 py-3"
                >
                  <Icon className={`mx-auto h-4 w-4 ${item.tone}`} />
                  <div className="mt-2 text-xs font-semibold text-txt">
                    {item.label}
                  </div>
                  <div className="mt-1 font-mono text-2xs text-muted">
                    {item.value}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="text-center text-xs text-muted">
            <div className="flex flex-wrap justify-center gap-1">
              {[
                "read_products",
                "read_orders",
                "read_inventory",
                "read_customers",
              ].map((scope) => (
                <code
                  key={scope}
                  className="rounded bg-bg-accent px-1.5 py-0.5 font-mono text-2xs"
                >
                  {scope}
                </code>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectionStatus({
  connected,
  loading,
  domain,
}: {
  connected: boolean;
  loading: boolean;
  domain?: string;
}) {
  if (loading) {
    return <Skeleton className="h-6 w-24 rounded-full" />;
  }

  if (connected && domain) {
    return (
      <div className="flex items-center gap-1.5">
        <Wifi className="h-3.5 w-3.5 text-ok" />
        <span className="text-xs font-medium text-ok">{domain}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <WifiOff className="h-3.5 w-3.5 text-muted/60" />
      <span className="text-xs text-muted">Not connected</span>
    </div>
  );
}

type DashboardTab =
  | "overview"
  | "products"
  | "orders"
  | "inventory"
  | "customers";

export function ShopifyAppView({ exitToApps }: OverlayAppContext) {
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");

  const {
    status,
    statusLoading,
    statusError,

    products,
    productsTotal,
    productsPage,
    productsLoading,
    productsError,
    productSearch,
    setProductSearch,
    setProductsPage,

    orders,
    ordersTotal,
    ordersLoading,
    ordersError,
    orderStatusFilter,
    setOrderStatusFilter,

    inventoryItems,
    inventoryLocations,
    inventoryLoading,
    inventoryError,

    customers,
    customersTotal,
    customersLoading,
    customersError,
    customerSearch,
    setCustomerSearch,

    counts,
    refresh,
  } = useShopifyDashboard();

  const connected = status?.connected ?? false;
  const shop = status?.shop ?? null;

  return (
    <div
      data-testid="shopify-shell"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-md">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={exitToApps}
          className="h-8 w-8 shrink-0"
          aria-label="Back to apps"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 shrink-0 text-muted-strong" />
          <span className="text-sm font-semibold text-txt">Shopify</span>
        </div>

        <div className="flex-1" />

        <ConnectionStatus
          connected={connected}
          loading={statusLoading}
          domain={shop?.domain}
        />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={refresh}
          aria-label="Refresh"
          disabled={statusLoading}
        >
          <RefreshCw
            className={`h-4 w-4 ${statusLoading ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {statusError ? (
          <div className="m-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {statusError}
          </div>
        ) : null}

        {!statusLoading && !connected ? (
          <div className="flex min-h-full items-center justify-center px-4 py-12">
            <ShopifySetupCard />
          </div>
        ) : statusLoading && !connected ? (
          <div className="flex min-h-full items-center justify-center">
            <Skeleton className="h-80 w-full max-w-lg rounded-2xl mx-4" />
          </div>
        ) : (
          <div className="px-4 py-4">
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as DashboardTab)}
            >
              <TabsList className="mb-4 h-auto flex-wrap gap-1 p-1">
                <TabsTrigger value="overview" className="gap-1.5">
                  <BarChart3 className="h-3.5 w-3.5" />
                  Overview
                </TabsTrigger>
                <TabsTrigger value="products" className="gap-1.5">
                  <Package className="h-3.5 w-3.5" />
                  Products
                </TabsTrigger>
                <TabsTrigger value="orders" className="gap-1.5">
                  <ShoppingCart className="h-3.5 w-3.5" />
                  Orders
                </TabsTrigger>
                <TabsTrigger value="inventory" className="gap-1.5">
                  <BarChart3 className="h-3.5 w-3.5" />
                  Inventory
                </TabsTrigger>
                <TabsTrigger value="customers" className="gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  Customers
                </TabsTrigger>
              </TabsList>

              <TabsContent value="overview">
                <div className="space-y-4">
                  {shop ? (
                    <StoreOverviewCard shop={shop} counts={counts} />
                  ) : null}

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-2xl border border-border/24 bg-card/32 px-4 py-4">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-bg-accent text-muted-strong"
                          title="Recent orders"
                        >
                          <ShoppingCart className="h-4 w-4" aria-hidden />
                        </span>
                      </div>
                      <div className="mt-3 space-y-2">
                        {ordersLoading && orders.length === 0 ? (
                          <>
                            <Skeleton className="h-8 w-full rounded-lg" />
                            <Skeleton className="h-8 w-full rounded-lg" />
                            <Skeleton className="h-8 w-full rounded-lg" />
                          </>
                        ) : (
                          orders.slice(0, 5).map((order) => (
                            <div
                              key={order.id}
                              className="flex items-center justify-between gap-2 rounded-lg bg-card/40 px-3 py-2"
                            >
                              <span className="text-xs font-semibold text-txt">
                                {order.name}
                              </span>
                              <span className="truncate text-xs-tight text-muted">
                                {order.email}
                              </span>
                              <span className="shrink-0 text-xs font-semibold text-txt">
                                {order.totalPrice} {order.currencyCode}
                              </span>
                            </div>
                          ))
                        )}
                        {orders.length === 0 && !ordersLoading ? (
                          <p className="text-xs text-muted">
                            No recent orders.
                          </p>
                        ) : null}
                      </div>
                      {ordersTotal > 5 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-7 rounded-full px-2 text-xs-tight"
                          onClick={() => setActiveTab("orders")}
                          title={`View all ${ordersTotal.toLocaleString()} orders`}
                        >
                          +{(ordersTotal - 5).toLocaleString()}
                        </Button>
                      ) : null}
                    </div>

                    <div className="rounded-2xl border border-border/24 bg-card/32 px-4 py-4">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-bg-accent text-muted-strong"
                          title="Low inventory"
                        >
                          <Package className="h-4 w-4" aria-hidden />
                        </span>
                      </div>
                      <div className="mt-3 space-y-2">
                        {inventoryLoading && inventoryItems.length === 0 ? (
                          <>
                            <Skeleton className="h-8 w-full rounded-lg" />
                            <Skeleton className="h-8 w-full rounded-lg" />
                          </>
                        ) : (
                          inventoryItems
                            .filter((item) => item.available <= 5)
                            .slice(0, 5)
                            .map((item) => (
                              <div
                                key={`${item.id}:${item.locationName}`}
                                className="flex items-center justify-between gap-2 rounded-lg bg-card/40 px-3 py-2"
                              >
                                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
                                  {item.productTitle}
                                  {item.variantTitle
                                    ? ` — ${item.variantTitle}`
                                    : ""}
                                </span>
                                <Badge
                                  variant={
                                    item.available === 0
                                      ? "destructive"
                                      : "secondary"
                                  }
                                  className="shrink-0 rounded-full text-2xs"
                                >
                                  {item.available}
                                </Badge>
                              </div>
                            ))
                        )}
                        {inventoryItems.filter((i) => i.available <= 5)
                          .length === 0 && !inventoryLoading ? (
                          <p className="text-xs text-muted">
                            All items sufficiently stocked.
                          </p>
                        ) : null}
                      </div>
                      {inventoryItems.filter((i) => i.available <= 5).length >
                      5 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-7 rounded-full px-2 text-xs-tight"
                          onClick={() => setActiveTab("inventory")}
                          title="View inventory"
                        >
                          +
                          {(
                            inventoryItems.filter((i) => i.available <= 5)
                              .length - 5
                          ).toLocaleString()}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="products">
                <ProductsPanel
                  products={products}
                  total={productsTotal}
                  page={productsPage}
                  loading={productsLoading}
                  error={productsError}
                  search={productSearch}
                  onSearchChange={setProductSearch}
                  onPageChange={setProductsPage}
                />
              </TabsContent>

              <TabsContent value="orders">
                <OrdersPanel
                  orders={orders}
                  total={ordersTotal}
                  loading={ordersLoading}
                  error={ordersError}
                  statusFilter={orderStatusFilter}
                  onStatusFilterChange={setOrderStatusFilter}
                />
              </TabsContent>

              <TabsContent value="inventory">
                <InventoryLevelsPanel
                  items={inventoryItems}
                  locations={inventoryLocations}
                  loading={inventoryLoading}
                  error={inventoryError}
                />
              </TabsContent>

              <TabsContent value="customers">
                <CustomersPanel
                  customers={customers}
                  total={customersTotal}
                  loading={customersLoading}
                  error={customersError}
                  search={customerSearch}
                  onSearchChange={setCustomerSearch}
                />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  );
}
