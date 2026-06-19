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
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  Globe2,
  KeyRound,
  type LucideIcon,
  Package,
  RefreshCw,
  ShoppingBag,
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

const SH_ACCENT = "var(--accent, #ff8a24)";
const SH_TXT = "var(--txt, #111)";
const SH_MUTED = "var(--muted, rgba(0,0,0,0.58))";
const SH_BORDER = "var(--border, rgba(0,0,0,0.12))";
const SH_SURFACE = "var(--surface, rgba(0,0,0,0.04))";
const SH_OK = "var(--ok, #22c55e)";

function SetupField({
  icon: Icon,
  label,
  description,
  envHint,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  envHint: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: 14,
        borderRadius: 14,
        border: `1px solid ${SH_BORDER}`,
        background: SH_SURFACE,
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          flexShrink: 0,
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--accent-subtle, rgba(255,138,36,0.14))",
          color: SH_ACCENT,
        }}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span
        style={{
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 600, color: SH_TXT }}>
          {label}
        </span>
        <span style={{ fontSize: 12, color: SH_MUTED, lineHeight: 1.4 }}>
          {description}
        </span>
        <code
          style={{
            marginTop: 3,
            fontSize: 10.5,
            color: SH_MUTED,
            opacity: 0.75,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {envHint}
        </code>
      </span>
    </div>
  );
}

function ShopifySetupCard() {
  return (
    <div className="mx-auto w-full max-w-md">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 6,
          marginBottom: 18,
        }}
      >
        <div
          style={{
            position: "relative",
            width: 84,
            height: 84,
            borderRadius: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--accent-subtle, rgba(255,138,36,0.14))",
            border: `1px solid ${SH_BORDER}`,
          }}
        >
          <ShoppingBag style={{ width: 38, height: 38, color: SH_ACCENT }} />
        </div>
        <h2
          style={{
            margin: "12px 0 0",
            fontSize: 20,
            fontWeight: 700,
            color: SH_TXT,
          }}
        >
          Connect your store
        </h2>
        <p
          style={{
            margin: 0,
            maxWidth: 320,
            fontSize: 13.5,
            color: SH_MUTED,
            lineHeight: 1.5,
          }}
        >
          Link a Shopify store to manage products, orders, and inventory right
          here.
        </p>
        <div
          style={{
            marginTop: 4,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px",
            borderRadius: 99,
            border: `1px solid ${SH_BORDER}`,
            background: SH_SURFACE,
            fontSize: 11.5,
            fontWeight: 600,
            color: SH_MUTED,
          }}
        >
          <WifiOff className="h-3 w-3" />
          Not connected
        </div>
      </div>

      <div
        style={{
          borderRadius: 18,
          border: `1px solid ${SH_BORDER}`,
          background: "var(--card, #fff)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <SetupField
          icon={Globe2}
          label="Store domain"
          description="Your shop address, e.g. mystore.myshopify.com"
          envHint="SHOPIFY_STORE_DOMAIN"
        />
        <SetupField
          icon={KeyRound}
          label="Access token"
          description="Admin API token with product, order & inventory scopes"
          envHint="SHOPIFY_ACCESS_TOKEN"
        />

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: "2px 2px 6px",
          }}
        >
          {[
            { label: "Products", icon: Package },
            { label: "Orders", icon: ShoppingCart },
            { label: "Stock", icon: BarChart3 },
          ].map(({ label, icon: Icon }) => (
            <span
              key={label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                borderRadius: 99,
                border: `1px solid ${SH_BORDER}`,
                background: SH_SURFACE,
                fontSize: 12,
                fontWeight: 600,
                color: SH_TXT,
              }}
            >
              <Icon style={{ width: 13, height: 13, color: SH_OK }} />
              {label}
            </span>
          ))}
        </div>

        <a
          href="/settings"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            height: 42,
            borderRadius: 12,
            background: SH_ACCENT,
            color: "var(--accent-foreground, #fff)",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          <Store className="h-4 w-4" />
          Configure in Settings
        </a>
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
      <div className="flex items-center gap-1.5 rounded-full border border-ok/20 bg-ok/10 px-2.5 py-1">
        <Wifi className="h-3.5 w-3.5 text-ok" />
        <span className="max-w-[10rem] truncate text-xs font-medium text-ok">
          {domain}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 rounded-full border border-danger/20 bg-danger/10 px-2.5 py-1">
      <WifiOff className="h-3.5 w-3.5 text-danger" />
      <span className="text-xs font-medium text-danger">Offline</span>
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
      className="h-9 w-9 gap-0 px-0 sm:w-auto sm:gap-1.5 sm:px-3"
      aria-current={active ? "true" : undefined}
      title={label}
      {...agentProps}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </TabsTrigger>
  );
}

function OverviewTile({
  icon: Icon,
  label,
  value,
  accent,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-24 items-start gap-3 rounded-xl border border-border/24 bg-card/35 px-3 py-3 text-left transition-colors hover:bg-card/55"
      title={label}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${accent}`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-2xl font-semibold leading-none text-txt">
          {value}
        </span>
        <span className="mt-2 block truncate text-xs font-medium text-muted">
          {label}
        </span>
      </span>
    </button>
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
  const lowInventoryItems = inventoryItems.filter(
    (item) => item.available <= 5,
  );
  const urgentInventoryCount = lowInventoryItems.filter(
    (item) => item.available === 0,
  ).length;

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
      <div className="flex shrink-0 items-center gap-3 border-b border-border/20 bg-bg/85 px-4 py-3 backdrop-blur-md">
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

        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border"
            style={{
              borderColor: connected
                ? "var(--ok-subtle, rgba(34,197,94,0.4))"
                : SH_BORDER,
              background: connected
                ? "var(--ok-subtle, rgba(34,197,94,0.1))"
                : "var(--accent-subtle, rgba(255,138,36,0.14))",
              color: connected ? SH_OK : SH_ACCENT,
            }}
          >
            <Store className="h-4 w-4" />
          </span>
          <span className="truncate text-sm font-semibold text-txt">
            {shop?.name ?? "Shopify"}
          </span>
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

      <div className="min-h-0 flex-1 overflow-y-auto pb-[calc(7rem+var(--safe-area-bottom,0px))]">
        {statusError ? (
          <div className="m-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {statusError}
          </div>
        ) : null}

        {!statusLoading && !connected ? (
          <div className="flex min-h-full items-center justify-center px-4 py-10">
            <ShopifySetupCard />
          </div>
        ) : statusLoading && !connected ? (
          <div className="flex min-h-full items-center justify-center">
            <Skeleton className="h-80 w-full max-w-lg rounded-2xl mx-4" />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-4">
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as DashboardTab)}
            >
              <TabsList className="sticky top-3 z-10 mb-4 h-auto w-full justify-between gap-1 rounded-2xl border border-border/30 bg-bg/80 p-1 shadow-sm backdrop-blur sm:w-auto sm:justify-start">
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
                  {shop ? <StoreOverviewCard shop={shop} /> : null}

                  <div className="grid gap-2 sm:grid-cols-2">
                    <OverviewTile
                      icon={Package}
                      label="Products"
                      value={counts.productCount.toLocaleString()}
                      accent="border-info/20 bg-info/10 text-info"
                      onClick={() => setActiveTab("products")}
                    />
                    <OverviewTile
                      icon={ShoppingCart}
                      label="Orders"
                      value={counts.orderCount.toLocaleString()}
                      accent="border-ok/20 bg-ok/10 text-ok"
                      onClick={() => setActiveTab("orders")}
                    />
                    <OverviewTile
                      icon={AlertTriangle}
                      label="Low stock"
                      value={lowInventoryItems.length.toLocaleString()}
                      accent={
                        urgentInventoryCount > 0
                          ? "border-danger/20 bg-danger/10 text-danger"
                          : "border-warn/20 bg-warn/10 text-warn"
                      }
                      onClick={() => setActiveTab("inventory")}
                    />
                    <OverviewTile
                      icon={Users}
                      label="Customers"
                      value={counts.customerCount.toLocaleString()}
                      accent="border-border/30 bg-bg-accent text-muted-strong"
                      onClick={() => setActiveTab("customers")}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="rounded-xl border border-border/24 bg-card/32 px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-bg-accent text-muted-strong"
                          title="Recent orders"
                        >
                          <ShoppingCart className="h-4 w-4" aria-hidden />
                        </span>
                        {ordersTotal > 3 ? (
                          <Button
                            ref={viewAllOrdersButton.ref}
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-full px-2 text-xs-tight"
                            onClick={() => setActiveTab("orders")}
                            title={`View all ${ordersTotal.toLocaleString()} orders`}
                            {...viewAllOrdersButton.agentProps}
                          >
                            +{(ordersTotal - 3).toLocaleString()}
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {ordersLoading && orders.length === 0 ? (
                          <>
                            <Skeleton className="h-8 w-full rounded-lg" />
                            <Skeleton className="h-8 w-full rounded-lg" />
                            <Skeleton className="h-8 w-full rounded-lg" />
                          </>
                        ) : (
                          orders.slice(0, 3).map((order) => (
                            <div
                              key={order.id}
                              className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-card/40 px-3 py-2"
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
                    </div>

                    <div className="rounded-xl border border-border/24 bg-card/32 px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-bg-accent text-muted-strong"
                          title="Low inventory"
                        >
                          <Package className="h-4 w-4" aria-hidden />
                        </span>
                        {lowInventoryItems.length > 3 ? (
                          <Button
                            ref={viewAllInventoryButton.ref}
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-full px-2 text-xs-tight"
                            onClick={() => setActiveTab("inventory")}
                            title="View inventory"
                            {...viewAllInventoryButton.agentProps}
                          >
                            +{(lowInventoryItems.length - 3).toLocaleString()}
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {inventoryLoading && inventoryItems.length === 0 ? (
                          <>
                            <Skeleton className="h-8 w-full rounded-lg" />
                            <Skeleton className="h-8 w-full rounded-lg" />
                          </>
                        ) : (
                          lowInventoryItems.slice(0, 3).map((item) => (
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
                        {lowInventoryItems.length === 0 && !inventoryLoading ? (
                          <p className="text-xs text-muted">
                            Stock levels look good.
                          </p>
                        ) : null}
                      </div>
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
          gridTemplateColumns: "1fr",
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
            {state?.orders?.total ?? 0} orders / {lowInventory.length} low stock
          </div>
          <div style={{ color: "#a7f3d0", marginBottom: 8 }}>recent orders</div>
          {(state?.orders?.orders ?? []).slice(0, 4).map((order) => (
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
          {lowInventory.slice(0, 4).map((item) => (
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
