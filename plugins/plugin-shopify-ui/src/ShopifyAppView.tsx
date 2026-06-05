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
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  BarChart3,
  ChevronLeft,
  Globe2,
  KeyRound,
  type LucideIcon,
  Package,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Store,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CustomersPanel } from "./CustomersPanel";
import { InventoryLevelsPanel } from "./InventoryLevelsPanel";
import { OrdersPanel } from "./OrdersPanel";
import { ProductsPanel } from "./ProductsPanel";
import { loadShopifyTuiState } from "./ShopifyAppView.helpers";
import { StoreOverviewCard } from "./StoreOverviewCard";
import { useShopifyDashboard } from "./useShopifyDashboard";

function ShopifySetupCard() {
  const setupItems = [
    { label: "Domain", value: "STORE_DOMAIN", icon: Globe2, tone: "text-info" },
    {
      label: "Token",
      value: "ACCESS_TOKEN",
      icon: KeyRound,
      tone: "text-warning",
    },
    { label: "Scopes", value: "read_*", icon: ShieldCheck, tone: "text-ok" },
  ] as const;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="rounded-2xl border border-border/30 bg-card/40 px-5 py-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-ok/25 bg-ok/12">
            <Store className="h-7 w-7 text-ok" />
          </div>
          <div className="text-lg font-semibold text-txt">Connect Shopify</div>

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

const DASHBOARD_TABS: {
  value: DashboardTab;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "overview", label: "Overview", icon: BarChart3 },
  { value: "products", label: "Products", icon: Package },
  { value: "orders", label: "Orders", icon: ShoppingCart },
  { value: "inventory", label: "Inventory", icon: BarChart3 },
  { value: "customers", label: "Customers", icon: Users },
];

function ShopifyDashboardTabTrigger({
  value,
  label,
  icon: Icon,
  active,
}: {
  value: DashboardTab;
  label: string;
  icon: LucideIcon;
  active: boolean;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tab-${value}`,
    role: "tab",
    label,
    group: "dashboard-tabs",
    status: active ? "active" : "inactive",
    description: `Show the ${label} tab`,
  });
  return (
    <TabsTrigger
      ref={ref}
      value={value}
      className="gap-1.5"
      aria-current={active ? "true" : undefined}
      {...agentProps}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </TabsTrigger>
  );
}

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

  const backButton = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: "Back to apps",
    group: "header",
    description: "Exit the Shopify dashboard and return to the apps grid",
  });
  const refreshButton = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",
    role: "button",
    label: "Refresh",
    group: "header",
    description: "Reload Shopify status and dashboard data",
  });
  const viewAllOrdersButton = useAgentElement<HTMLButtonElement>({
    id: "overview-view-all-orders",
    role: "button",
    label: "View all orders",
    group: "overview",
    description: "Jump to the orders tab from the overview summary",
    onActivate: () => setActiveTab("orders"),
  });
  const viewAllInventoryButton = useAgentElement<HTMLButtonElement>({
    id: "overview-view-inventory",
    role: "button",
    label: "View inventory",
    group: "overview",
    description: "Jump to the inventory tab from the overview summary",
    onActivate: () => setActiveTab("inventory"),
  });

  return (
    <div
      data-testid="shopify-shell"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-md">
        <Button
          ref={backButton.ref}
          type="button"
          variant="ghost"
          size="icon"
          onClick={exitToApps}
          className="h-8 w-8 shrink-0"
          aria-label="Back to apps"
          {...backButton.agentProps}
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
          ref={refreshButton.ref}
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={refresh}
          aria-label="Refresh"
          disabled={statusLoading}
          {...refreshButton.agentProps}
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
                {DASHBOARD_TABS.map((tab) => (
                  <ShopifyDashboardTabTrigger
                    key={tab.value}
                    value={tab.value}
                    label={tab.label}
                    icon={tab.icon}
                    active={activeTab === tab.value}
                  />
                ))}
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
                          ref={viewAllOrdersButton.ref}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-7 rounded-full px-2 text-xs-tight"
                          onClick={() => setActiveTab("orders")}
                          title={`View all ${ordersTotal.toLocaleString()} orders`}
                          {...viewAllOrdersButton.agentProps}
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
                          ref={viewAllInventoryButton.ref}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-7 rounded-full px-2 text-xs-tight"
                          onClick={() => setActiveTab("inventory")}
                          title="View inventory"
                          {...viewAllInventoryButton.agentProps}
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

export function ShopifyTuiView() {
  const [state, setState] = useState<Awaited<
    ReturnType<typeof loadShopifyTuiState>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadShopifyTuiState();
      setState(next);
      setLastAction("refresh");
    } catch (caught) {
      setState(null);
      setError(
        caught instanceof Error ? caught.message : "Shopify refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lowInventory =
    state?.inventory?.items.filter((item) => item.available <= 5) ?? [];
  const viewState = {
    viewType: "tui",
    viewId: "shopify",
    connected: state?.status.connected ?? false,
    domain: state?.status.shop?.domain ?? null,
    productCount: state?.products?.total ?? 0,
    orderCount: state?.orders?.total ?? 0,
    inventoryCount: state?.inventory?.items.length ?? 0,
    lowInventoryCount: lowInventory.length,
    customerCount: state?.customers?.total ?? 0,
    loading,
    lastAction,
    error,
  };

  return (
    <div
      data-view-state={JSON.stringify(viewState)}
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://shopify --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {loading
          ? "loading"
          : state?.status.connected
            ? "connected"
            : "not-connected"}{" "}
        | {state?.status.shop?.domain ?? "no shop"} | {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)",
          gap: 16,
        }}
      >
        <section
          aria-label="Shopify status"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <strong style={{ color: "#e2e8f0" }}>store</strong>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                background: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              refresh
            </button>
          </div>
          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          <div style={{ marginBottom: 12 }}>
            <div>
              <span style={{ color: "#64748b" }}>connected</span>{" "}
              {state?.status.connected ? "yes" : "no"}
            </div>
            <div>
              <span style={{ color: "#64748b" }}>shop</span>{" "}
              {state?.status.shop?.name ?? "not configured"}
            </div>
            <div>
              <span style={{ color: "#64748b" }}>domain</span>{" "}
              {state?.status.shop?.domain ?? "SHOPIFY_STORE_DOMAIN required"}
            </div>
          </div>
          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>counts</div>
          <div>products {state?.products?.total ?? 0}</div>
          <div>orders {state?.orders?.total ?? 0}</div>
          <div>customers {state?.customers?.total ?? 0}</div>
          <div>inventory rows {state?.inventory?.items.length ?? 0}</div>
          <div style={{ color: "#fca5a5" }}>
            low inventory {lowInventory.length}
          </div>
          {!state?.status.connected && !loading ? (
            <div style={{ color: "#94a3b8", marginTop: 18 }}>
              Configure SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN for live
              data.
            </div>
          ) : null}
        </section>

        <section
          aria-label="Shopify commerce"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>commerce</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            commands: state | products | orders | inventory | customers |
            create-product | adjust-inventory
          </div>
          <div style={{ color: "#a7f3d0", marginBottom: 8 }}>recent orders</div>
          {(state?.orders?.orders ?? []).slice(0, 6).map((order) => (
            <div
              key={order.id}
              style={{
                display: "grid",
                gridTemplateColumns: "9ch minmax(0,1fr) 10ch",
                gap: 10,
                borderTop: "1px solid rgba(125,211,252,0.14)",
                padding: "7px 0",
              }}
            >
              <span>{order.name}</span>
              <span style={{ color: "#94a3b8" }}>{order.email}</span>
              <span style={{ color: "#e2e8f0" }}>
                {order.totalPrice} {order.currencyCode}
              </span>
            </div>
          ))}
          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>
            low inventory
          </div>
          {lowInventory.slice(0, 8).map((item) => (
            <div
              key={`${item.id}:${item.locationName}`}
              style={{ padding: "5px 0" }}
            >
              {item.productTitle}
              {item.variantTitle ? ` / ${item.variantTitle}` : ""} @{" "}
              {item.locationName}: {item.available}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
