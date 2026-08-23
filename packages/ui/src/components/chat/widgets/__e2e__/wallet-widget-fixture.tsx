/**
 * Render fixture for the wallet price surface (#14344, #16943). Two modes,
 * chosen by the URL; the runner stubs `../../../api` with the matching
 * response:
 *
 *   - default (widget-only): mounts the REAL `WalletBalanceWidget` on an
 *     orange home-like field so the screenshot harness captures the
 *     no-holdings DEFAULT state (BTC/SOL/ETH price rows), the HELD state
 *     (top-3 held by holding value, price-only), and the UNAVAILABLE state
 *     where a failed balance request must not look like an empty wallet.
 *
 *   - `?surface=wallet-section`: mounts the REAL `WalletSectionNav` (real
 *     app-shell page registry, real section tabs) — the decided routed mount
 *     after the home spec demoted the `wallet.balance` resident — and proves
 *     the price rows render on that surface, not only in isolation.
 */
import { createRoot } from "react-dom/client";
import { registerAppShellPage } from "../../../../app-shell-registry";
import { WalletSectionNav } from "../../../pages/WalletSectionNav";
import { WalletBalanceWidget } from "../wallet-balance";

const params = new URLSearchParams(location.search);
const state = params.get("state");
const surface = params.get("surface");

function WalletSectionSurface(): React.JSX.Element {
  return (
    <div
      style={{
        background: "#101014",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <WalletSectionNav activePath="/wallet" />
      <div
        style={{
          color: "rgba(255,255,255,0.4)",
          font: "500 12px system-ui",
          padding: "24px",
          textAlign: "center",
        }}
      >
        (inventory page body renders below the section chrome)
      </div>
    </div>
  );
}

function WidgetField(): React.JSX.Element {
  return (
    <div
      // The real home field is the orange accent surface; the widget is a
      // chromeless tile on it. A fixed narrow column mimics the 2-col home grid.
      style={{
        background: "#e8590c",
        minHeight: "100dvh",
        display: "grid",
        placeItems: "start center",
        padding: "48px 0",
      }}
    >
      <div style={{ width: 360 }}>
        <div
          data-testid="wallet-state-label"
          style={{
            color: "rgba(255,255,255,0.85)",
            font: "600 13px system-ui",
            marginBottom: 8,
            textAlign: "center",
          }}
        >
          {state === "held"
            ? "HELD: top-3 by holding value"
            : state === "unavailable"
              ? "UNAVAILABLE: holdings unknown"
              : "DEFAULT: no holdings"}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <WalletBalanceWidget spanClassName="col-span-2 row-span-1" />
        </div>
      </div>
    </div>
  );
}

if (surface === "wallet-section") {
  // Real registrations drive the real SectionNav strip: the inventory root
  // (aliased to /wallet) plus one sub-view so the tab strip renders.
  registerAppShellPage({
    id: "wallet.inventory",
    pluginId: "wallet",
    label: "Wallet",
    path: "/inventory",
    tabAffinity: "inventory",
    group: "wallet",
    order: 10,
    loader: async () => ({ default: () => null }),
  });
  registerAppShellPage({
    id: "wallet.perps",
    pluginId: "wallet",
    label: "Perps",
    path: "/perps",
    tabAffinity: "inventory",
    group: "wallet",
    order: 20,
    loader: async () => ({ default: () => null }),
  });
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  surface === "wallet-section" ? <WalletSectionSurface /> : <WidgetField />,
);
