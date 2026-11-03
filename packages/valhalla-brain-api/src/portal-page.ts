/** Portal page script. It may call signMessage only. It must not name a transaction signer. */
export const PORTAL_JS = `fetch("/version.json", { cache: "no-store" }).then(function (res) { return res.ok ? res.json() : null; }).then(function (doc) {
  if (!doc || !doc.version) return;
  var key = "valhalla-portal-version";
  var seen = localStorage.getItem(key);
  if (seen && seen !== doc.version) { localStorage.setItem(key, doc.version); location.reload(); return; }
  localStorage.setItem(key, doc.version);
}).catch(function () {});
const api = "";
function say(id, text) { const node = document.getElementById(id); if (node) node.textContent = text; }
function csrf() { const hit = document.cookie.split("; ").find((row) => row.startsWith("valhalla_csrf=")); return hit ? decodeURIComponent(hit.split("=")[1]) : ""; }
async function send(path, body) {
  const response = await fetch(api + path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf": csrf() }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function wallets() {
  const found = [];
  window.addEventListener("wallet-standard:register-wallet", (event) => { found.push(event.detail); });
  window.dispatchEvent(new Event("wallet-standard:app-ready"));
  return found;
}
async function signInWallet() {
  const list = wallets().filter((item) => /phantom|solflare|backpack/i.test(item.name || ""));
  const wallet = list[0];
  if (!wallet || !wallet.features || !wallet.features["solana:signMessage"]) { say("login-note", "Open Phantom, Solflare, or Backpack, then try again. Valhalla only asks you to sign a login message."); return; }
  await wallet.features["standard:connect"].connect();
  const account = wallet.accounts[0];
  const nonce = await send("/v1/auth/nonce", { pubkey: account.address });
  const signed = await wallet.features["solana:signMessage"].signMessage({ account, message: new TextEncoder().encode(nonce.message) });
  const bytes = signed.signature || signed[0].signature;
  const signature = btoa(String.fromCharCode(...bytes));
  await send("/v1/auth/siws", { pubkey: account.address, signature, nonce: nonce.nonce });
  location.hash = "#dashboard";
  await draw();
}
async function signInGoogle(credential) { await send("/v1/auth/google", { credential }); location.hash = "#dashboard"; await draw(); }
function lock(on, html) { return on ? '<div class="lock"><span>Locked</span>' + html + '<button type="button" id="upgrade">Upgrade</button></div>' : html; }
async function draw() {
  const probe = await fetch(api + "/v1/auth/config", { credentials: "same-origin" }).catch(() => null);
  if (!probe || !probe.ok) {
    say("login-note", "Sign-in runs on the Brain API worker. Until app.valhalla-app.xyz points at that worker, this page cannot start a session.");
    return;
  }
  const me = await fetch("/v1/me", { credentials: "same-origin" }).then((res) => res.ok ? res.json() : null).catch(() => null);
  document.getElementById("login").hidden = Boolean(me);
  document.getElementById("app").hidden = !me;
  if (!me) return;
  const pro = me.plan === "pro";
  say("who", (me.email || "Wallet") + " · " + me.plan);
  const report = await send("/v1/me/report");
  document.getElementById("report").innerHTML = lock(!pro, report.locked ? report.preview : report.note);
  const offers = document.getElementById("offers");
  if (offers) {
    offers.hidden = pro || location.hash === "#account";
    if (!pro && !offers.dataset.loaded) {
      offers.dataset.loaded = "1";
      const label = "Affiliate link · we may earn a commission";
      fetch("https://valhalla-app.xyz/offers.json").then((res) => res.ok ? res.json() : null).then((doc) => {
        const rows = doc && Array.isArray(doc.offers) ? doc.offers : [];
        const live = rows.filter((row) => typeof row.url === "string" && row.url.indexOf("https://") === 0 && (row.placements || []).indexOf("portal") >= 0);
        const chart = rows.filter((row) => typeof row.url === "string" && row.url.indexOf("https://") === 0 && (row.placements || []).indexOf("report-card") >= 0)[0];
        const note = document.createElement("p");
        note.className = "note";
        if (chart) {
          const link = document.createElement("a");
          link.href = chart.url;
          link.target = "_blank";
          link.rel = "sponsored noopener noreferrer";
          link.textContent = "Chart better. " + chart.partner + ".";
          link.addEventListener("click", () => { fetch("/v1/offers/click", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: chart.id, placement: "report-card" }) }).catch(() => {}); });
          note.appendChild(link);
          note.appendChild(document.createTextNode(" " + label + ". Not trading advice."));
        } else {
          note.textContent = "Chart better. Not trading advice.";
        }
        document.getElementById("report").appendChild(note);
        const list = document.getElementById("offer-list");
        if (!list) return;
        if (!live.length) {
          const empty = document.createElement("p");
          empty.className = "note";
          empty.textContent = "Partner links are not connected yet. Not trading advice.";
          list.appendChild(empty);
          return;
        }
        live.forEach((row) => {
          const link = document.createElement("a");
          link.href = row.url;
          link.target = "_blank";
          link.rel = "sponsored noopener noreferrer";
          link.textContent = row.partner + ": " + row.title;
          link.addEventListener("click", () => { fetch("/v1/offers/click", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: row.id, placement: "portal" }) }).catch(() => {}); });
          const line = document.createElement("p");
          line.appendChild(link);
          list.appendChild(line);
        });
        const fine = document.createElement("p");
        fine.className = "note";
        fine.textContent = label + ". Not trading advice.";
        list.appendChild(fine);
      }).catch(() => {
        const note = document.createElement("p");
        note.className = "note";
        note.textContent = "Chart better. Not trading advice.";
        const report = document.getElementById("report");
        if (report) report.appendChild(note);
      });
    }
  }
  const ad = document.getElementById("portal-ad");
  if (ad) {
    ad.hidden = pro || location.hash === "#account";
    if (!ad.hidden && !ad.dataset.loaded) {
      const script = document.createElement("script");
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6504655762357230";
      script.onload = function () { (window.adsbygoogle = window.adsbygoogle || []).push({}); };
      document.head.appendChild(script);
      ad.dataset.loaded = "1";
    }
  }
  document.getElementById("upgrade")?.addEventListener("click", () => { location.hash = "#account"; });
  const balances = await send("/v1/me/balances");
  say("balances", balances.note);
  say("account", "Plan " + me.plan + ". License " + (me.licenseTail || "none") + ".");
}
async function payCrypto(asset) {
  try {
    const order = await send("/v1/crypto/order", { plan: "monthly", asset });
    say("crypto-out", "Recipient ends " + order.recipientTail + ". " + order.refunds + " Open " + order.phantom);
  } catch (err) {
    say("crypto-out", err.message);
  }
}
document.getElementById("pay-usdc")?.addEventListener("click", () => { payCrypto("usdc"); });
document.getElementById("pay-sol")?.addEventListener("click", () => { payCrypto("sol"); });
document.getElementById("siws")?.addEventListener("click", () => { signInWallet().catch((err) => say("login-note", err.message)); });
document.getElementById("logout")?.addEventListener("click", () => { send("/v1/auth/logout", {}).then(() => location.reload()); });
draw().catch(() => {});
`;

export const PORTAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Valhalla Pro</title>
<style>
body { margin: 0; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; background: radial-gradient(circle at 0 0, rgba(255,179,71,.18), transparent 36%), #07080b; color: #f4ecdf; }
section { background: rgba(16,16,20,.72); border: 1px solid rgba(255,179,71,.22); border-radius: 16px; padding: 12px; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { color: #e8b65a; letter-spacing: .08em; }
button, a.btn { background: #e8b65a; color: #07080b; border: 0; min-height: 40px; padding: 0 16px; font-weight: 700; text-decoration: none; display: inline-block; line-height: 40px; }
.note { color: #93a4ba; }
.lock { filter: grayscale(1); opacity: .72; border: 1px solid #3a3428; padding: 12px; }
section { margin: 24px 0; }
</style>
</head>
<body>
<main>
<h1>VALHALLA</h1>
<p class="note">Read-only portal. Sign-in proves you hold the wallet. It does not send or withdraw. Not financial advice. The login cookie is set by this host. For the public site, use https://valhalla-app.xyz/app until app.valhalla-app.xyz points here.</p>
<section id="login">
<h2>Log in</h2>
<button id="siws" type="button">Sign in with Phantom, Solflare, or Backpack</button>
<div id="google"></div>
<p id="login-note" class="note">The login message expires quickly. Valhalla never asks for a seed phrase.</p>
</section>
<section id="app" hidden>
<p id="who"></p>
<nav><a href="#dashboard">Dashboard</a> <a href="#account">Account</a> <button id="logout" type="button">Sign out</button></nav>
<section id="dashboard"><h2>Dashboard</h2><p id="balances"></p><h3>Trader Report Card</h3><div id="report"></div>
<aside id="offers" hidden><h3>Recommended tools</h3><div id="offer-list"></div><p class="note"><a href="https://valhalla-app.xyz/tools/">All tools</a></p></aside>
<aside id="portal-ad" hidden><p class="note">Advertisement</p><ins class="adsbygoogle" style="display:block;min-height:90px" data-ad-client="ca-pub-6504655762357230" data-ad-format="auto" data-full-width-responsive="true"></ins></aside>
</section>
<section id="account"><h2>Account</h2><p id="account"></p><p><a class="btn" id="billing" href="https://app.lemonsqueezy.com/my-orders">Pay with card</a></p>
<h3>Pay with crypto</h3>
<p class="note">Monthly is $9.99, yearly is $149, and lifetime is $199. Those prices come from the signed config. USDC is the default. A SOL quote locks for 10 minutes. Refunds are manual. This page never holds a wallet key.</p>
<button id="pay-usdc" type="button">Pay monthly with USDC</button>
<button id="pay-sol" type="button">Pay monthly with SOL</button>
<p id="crypto-out" class="note"></p>
</section>
</main>
<script src="/app/portal.js"></script>
</body>
</html>`;
