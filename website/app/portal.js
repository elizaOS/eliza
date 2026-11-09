fetch("/version.json", { cache: "no-store" }).then(function (res) { return res.ok ? res.json() : null; }).then(function (doc) {
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
document.getElementById("siws")?.addEventListener("click", () => { signInWallet().catch((err) => say("login-note", err.message)); });
document.getElementById("logout")?.addEventListener("click", () => { send("/v1/auth/logout", {}).then(() => location.reload()); });
draw().catch(() => {});
