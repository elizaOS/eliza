/**
 * Render fixture for the WALLET home widget (#14344). Mounts the REAL
 * `WalletBalanceWidget` on an orange home-like field so the screenshot harness
 * can capture both states in a real browser without an app server: the
 * no-holdings DEFAULT state (BTC/SOL/ETH price rows) and the HELD state (top-3
 * held by holding value, price-only). The state is chosen by `?state=held` in
 * the URL; the `../../../api` client is stubbed by the runner to return the
 * matching balances/overview.
 */
import { createRoot } from "react-dom/client";
import { WalletBalanceWidget } from "../wallet-balance";

const held = new URLSearchParams(location.search).get("state") === "held";

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <div
    // The real home field is the orange accent surface; the widget is a
    // chromeless tile on it. A fixed narrow column mimics the 2-col home grid.
    style={{
      background: "#e8590c",
      minHeight: "100vh",
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
        {held ? "HELD — top-3 by holding value" : "DEFAULT — no holdings"}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <WalletBalanceWidget spanClassName="col-span-2 row-span-1" />
      </div>
    </div>
  </div>,
);
