const desk = document.getElementById("desk");
const code = document.getElementById("code");
const status = document.getElementById("status");
const RPC = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
let proTradesLeft = 100;
let proAllowance = 100;
let balanceTimer = 0;

function say(text) {
  if (status) status.textContent = text;
}

function tail(address) {
  return `…${String(address).slice(-4)}`;
}

function showChoice(on) {
  const choice = document.getElementById("connect-choice");
  const watch = document.getElementById("watch");
  if (choice) choice.hidden = !on;
  if (watch) watch.hidden = on;
}

async function allowOrigin(origin) {
  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;
  return chrome.permissions.request({ origins: [origin] });
}

function openConnect(which) {
  const ext = chrome.runtime.id;
  const site = `https://valhalla-app.xyz/connect/?wallet=${which}&ext=${encodeURIComponent(ext)}`;
  chrome.tabs.create({ url: site }, () => {
    if (chrome.runtime.lastError) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`connect.html?wallet=${which}`) });
    }
  });
}

document.getElementById("use-paste")?.addEventListener("click", () => {
  const panel = document.getElementById("paste-panel");
  if (panel) panel.hidden = false;
});
document.getElementById("use-phantom")?.addEventListener("click", () => openConnect("phantom"));
document.getElementById("use-solflare")?.addEventListener("click", () => openConnect("solflare"));

async function saveAddress(address) {
  if (!ValhallaConnect.isPubkey(address)) {
    const error = document.getElementById("address-error");
    if (error) error.textContent = "That is not a Solana address.";
    return;
  }
  const allowed = await allowOrigin(`${RPC}/*`);
  if (!allowed) {
    const error = document.getElementById("address-error");
    if (error) error.textContent = "Chrome did not allow the balance lookup. The address was not saved.";
    return;
  }
  await chrome.storage.local.set({ watchAddress: address, siwsSession: null });
  await showWatch(address);
}

document.getElementById("save-address")?.addEventListener("click", () => {
  const input = document.getElementById("address");
  saveAddress(input ? input.value.trim() : "");
});

document.getElementById("change")?.addEventListener("click", () => {
  showChoice(true);
  const panel = document.getElementById("paste-panel");
  if (panel) panel.hidden = false;
});

document.getElementById("remove")?.addEventListener("click", async () => {
  await chrome.storage.local.remove(["watchAddress", "siwsSession"]);
  showChoice(true);
  const balances = document.getElementById("balances");
  if (balances) balances.textContent = "";
});

async function showWatch(address) {
  showChoice(false);
  const node = document.getElementById("tail");
  if (node) node.textContent = tail(address);
  await loadBalances(address);
}

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error("The balance lookup did not answer.");
  const body = await response.json();
  if (body.error) throw new Error("The balance lookup did not answer.");
  return body.result;
}

async function loadBalances(address) {
  const balances = document.getElementById("balances");
  const updated = document.getElementById("updated");
  const allowed = await chrome.permissions.contains({ origins: [`${RPC}/*`] });
  if (!allowed) {
    if (balances) balances.textContent = "Allow the public RPC to load balances. Nothing is sent.";
    return;
  }
  try {
    const lamports = await rpc("getBalance", [address]);
    const sol = Number(lamports && lamports.value) / 1_000_000_000;
    const tokens = await rpc("getTokenAccountsByOwner", [
      address,
      { programId: TOKEN_PROGRAM },
      { encoding: "jsonParsed" },
    ]);
    const rows = [`SOL ${Number.isFinite(sol) ? sol.toFixed(4) : "0"}`];
    const list = (tokens && tokens.value) || [];
    for (const row of list.slice(0, 6)) {
      const info = row.account && row.account.data && row.account.data.parsed && row.account.data.parsed.info;
      const amount = info && info.tokenAmount;
      const mint = info && info.mint ? String(info.mint).slice(0, 4) : "coin";
      rows.push(`${mint} ${amount && amount.uiAmountString ? amount.uiAmountString : "0"}`);
    }
    if (balances) balances.textContent = rows.join("\n");
    if (updated) {
      updated.textContent = `Last updated ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`;
    }
  } catch {
    if (balances) balances.textContent = "Balances did not load. The address is saved. Nothing was sent.";
  }
}

document.getElementById("refresh-balances")?.addEventListener("click", async () => {
  const saved = await chrome.storage.local.get(["watchAddress"]);
  if (!saved.watchAddress) return;
  const allowed = await allowOrigin(`${RPC}/*`);
  if (!allowed) {
    const balances = document.getElementById("balances");
    if (balances) balances.textContent = "Chrome did not allow the balance lookup.";
    return;
  }
  await loadBalances(saved.watchAddress);
});

function paintAllowance(left, allowance) {
  proTradesLeft = left;
  proAllowance = allowance;
  const node = document.getElementById("pro-left");
  if (node) node.textContent = `Pro trades left: ${left}/${allowance}`;
  const preview = document.getElementById("pro-preview");
  const upsell = document.getElementById("upsell");
  const spent = left <= 0;
  if (preview) preview.classList.toggle("spent", spent);
  if (upsell) upsell.hidden = !spent;
}

async function loadAllowance() {
  let left = 100;
  let allowance = 100;
  try {
    const file = await fetch(chrome.runtime.getURL("monetization.json")).then((res) => res.json());
    const signed = ValhallaTrust.verifyMonetization(nacl, file);
    if (!signed) {
      paintAllowance(0, 0);
      reportTamper("extension");
      return;
    }
    allowance = Number(signed.proTradeAllowance);
    const go = document.getElementById("go-pro");
    if (go && signed.checkoutUrl) go.href = signed.checkoutUrl;
    left = allowance;
  } catch {
    paintAllowance(0, 0);
    return;
  }
  const saved = await chrome.storage.local.get(["desk", "proSigned"]);
  if (saved.proSigned && acceptCounter(saved.proSigned, allowance)) left = Number(saved.proSigned.remaining);
  if (saved.desk) {
    try {
      const response = await fetch(`${saved.desk.replace(/\/$/, "")}/api/pro-trades`);
      if (response.ok) {
        const body = await response.json();
        if (acceptCounter(body, allowance)) {
          left = Number(body.remaining);
          await chrome.storage.local.set({ proSigned: body });
        } else if (Number.isFinite(Number(body.remaining))) {
          left = Math.min(allowance, Math.max(0, Number(body.remaining)));
        }
      }
    } catch {
      // The desk did not answer. Keep the signed allowance.
    }
  }
  paintAllowance(left, allowance);
}

function acceptCounter(body, allowance) {
  if (!body || !body.signature || !body.identity) return false;
  if (Number(body.allowance) !== allowance) return false;
  const message = ValhallaTrust.counterMessage(body);
  return ValhallaTrust.verify(nacl, message, body.signature);
}

async function allowDesk(base) {
  const origin = `${new URL(base).origin}/*`;
  return allowOrigin(origin);
}

document.getElementById("pair")?.addEventListener("click", async () => {
  const base = desk.value.trim().replace(/\/$/, "");
  if (!base.startsWith("http://127.0.0.1") && !base.startsWith("http://localhost")) {
    say("Use the desk on this computer. The extension will not call a public host.");
    return;
  }
  const allowed = await allowDesk(base);
  if (!allowed) {
    say("Chrome did not allow the desk on this computer. Nothing was sent.");
    return;
  }
  say("Asking the desk.");
  try {
    const paired = await fetch(`${base}/api/companion/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: code.value }),
    });
    const body = await paired.json();
    if (!paired.ok || !body.token) {
      say("The desk did not pair. Check the address and the access code.");
      return;
    }
    await chrome.storage.local.set({ desk: base, token: body.token });
    code.value = "";
    await loadState(base, body.token);
    await loadAllowance();
  } catch {
    say("The desk did not answer. It may be off. Nothing was sent.");
  }
});

function localScore(mint) {
  const flags = ["local fallback", "not financial advice"];
  let score = 40;
  if (mint.length >= 32 && mint.length <= 44) score = 55;
  else flags.push("unexpected address length");
  return { score, flags };
}

document.getElementById("score")?.addEventListener("click", async () => {
  const mint = document.getElementById("mint").value.trim();
  const out = document.getElementById("score-out");
  const saved = await chrome.storage.local.get(["desk"]);
  if (saved.desk) {
    try {
      const response = await fetch(
        `${saved.desk.replace(/\/$/, "")}/api/signal?mint=${encodeURIComponent(mint)}`
      );
      if (response.ok) {
        const body = await response.json();
        out.textContent = `Score ${body.score}. ${(body.flags || []).join(", ")}. ${body.disclaimer || "Not financial advice."}${body.offer ? ` ${body.offer}` : ""}`;
        if (typeof body.score === "number" && body.score <= 40) showHouseAd("risk-score");
        return;
      }
    } catch {
      // The desk did not answer. Use the local score.
    }
  }
  const local = localScore(mint);
  const risk = local.score <= 40 ? " Protect your coins: hardware wallet. Not trading advice." : "";
  out.textContent = `Score ${local.score}. ${local.flags.join(", ")}.${risk}`;
  if (local.score <= 40) showHouseAd("risk-score");
});

function reportTamper(surface) {
  const event = { event: "monetization-tamper", surface };
  console.error(JSON.stringify(event));
}

async function signedOffers() {
  const doc = await fetch(chrome.runtime.getURL("offers.json")).then((res) => res.json());
  const offers = ValhallaTrust.verifyOffers(nacl, doc);
  if (!offers) {
    reportTamper("extension-offers");
    return [];
  }
  return offers;
}

async function showHouseAd(placement) {
  const box = document.getElementById("house-ad");
  if (!box) return;
  if (proTradesLeft > 0) {
    box.hidden = true;
    return;
  }
  try {
    const saved = await chrome.storage.local.get(["desk"]);
    if (saved.desk) {
      try {
        const plan = await fetch(`${saved.desk.replace(/\/$/, "")}/api/plan`);
        if (plan.ok) {
          const body = await plan.json();
          if (body.tier === "pro" || body.tier === "trial" || body.lifetime === true) {
            box.hidden = true;
            return;
          }
        }
      } catch {
        // The desk did not answer. Keep the free house banner.
      }
    }
    const offers = await signedOffers();
    const spot = placement || "extension";
    const live = offers.filter(
      (row) => String(row.url || "").startsWith("https://") && (row.placements || []).includes(spot)
    );
    const label = document.getElementById("house-label");
    const link = document.getElementById("house-link");
    const image = document.getElementById("house-image");
    const title = document.getElementById("house-title");
    const disclosure = document.getElementById("house-disclosure");
    if (live.length) {
      const offer = live[Math.floor(Date.now() / 86400000) % live.length];
      if (label) label.textContent = "Affiliate link · we may earn a commission";
      if (link) link.href = offer.url;
      if (image) image.hidden = true;
      if (title) title.textContent = `${offer.partner}: ${offer.title}`;
      if (disclosure) disclosure.textContent = "Not trading advice.";
      box.hidden = false;
      return;
    }
    const response = await fetch(chrome.runtime.getURL("house-ads.json"));
    const data = await response.json();
    const ads = Array.isArray(data.ads) ? data.ads : [];
    if (!ads.length) return;
    const ad = ads[Math.floor(Date.now() / 86400000) % ads.length];
    if (label) label.textContent = ad.label || "Ad";
    if (link) link.href = ad.href;
    if (image) {
      image.hidden = false;
      image.src = chrome.runtime.getURL(ad.image);
    }
    if (title) title.textContent = ad.title || "";
    if (disclosure) disclosure.textContent = ad.disclosure || "";
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}

async function loadState(base, token) {
  const response = await fetch(`${base}/api/companion/state`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok) {
    say("Pair again. The desk did not accept this browser.");
    return;
  }
  const row = body.state || {};
  say(
    `${row.status || "Desk answered."}\n${row.pnl || ""}\n${row.positions || ""}\nRead-only. No send or withdraw.`
  );
  await showHouseAd();
}

async function boot() {
  const saved = await chrome.storage.local.get(["desk", "token", "watchAddress"]);
  if (saved.desk && desk) desk.value = saved.desk;
  if (saved.watchAddress && ValhallaConnect.isPubkey(saved.watchAddress)) await showWatch(saved.watchAddress);
  await loadAllowance();
  await showHouseAd();
  if (saved.token && saved.desk) await loadState(saved.desk, saved.token);
  balanceTimer = window.setInterval(async () => {
    const current = await chrome.storage.local.get(["watchAddress"]);
    if (current.watchAddress) await loadBalances(current.watchAddress);
  }, 30000);
}

boot();
