function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
async function load() {
  const [state, meta, pnl] = await Promise.all([
    fetch("/api/state").then((r) => r.json()),
    fetch("/api/meta").then((r) => r.json()),
    fetch("/api/pnl").then((r) => r.json()),
  ]);
  document.getElementById("nmode").textContent = state.live ? "LIVE" : "READ ONLY";
  document.getElementById("wbal").textContent = "$" + Number(state.equityUsd || 0).toFixed(2);
  const tp = Number(pnl.tradingPnlUsd || 0);
  document.getElementById("bal").textContent = (tp >= 0 ? "+" : "") + "$" + tp.toFixed(2);
  document.getElementById("pnl").textContent = (Number(pnl.tradingPnlSol) || 0).toFixed(4) + " SOL";
  document.getElementById("meta").textContent = "wallet " + (meta.pubkey || "—");
  document.getElementById("rules").innerHTML = (meta.rules || []).map((rule) => "<div>· " + esc(rule) + "</div>").join("");
  const pos = state.positions || [];
  document.getElementById("pos").innerHTML = pos.length
    ? pos.map((p) => "<div>$" + esc(p.ticker) + " " + esc(p.mint) + " " + (Number(p.pnlPct) * 100).toFixed(1) + "%</div>").join("")
    : "none";
  const lines = await fetch("/api/decisions").then((r) => r.json());
  document.getElementById("term").textContent = (lines.lines || []).slice(0, 30).join("\n");
}
load();
setInterval(load, 4000);
