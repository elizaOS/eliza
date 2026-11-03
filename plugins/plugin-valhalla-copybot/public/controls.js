async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) {
    document.getElementById("gate").hidden = false;
  }
  if (!res.ok) throw new Error(data.error || data.message || "request failed");
  return data;
}

function say(text) {
  const log = document.getElementById("chatLog");
  if (!log) return;
  const line = document.createElement("div");
  line.textContent = "> " + text;
  log.prepend(line);
}

let liveTimer = 0;
let liveAddress = "";
let liveAt = 0;

async function refreshLive() {
  const badge = document.getElementById("liveBadge");
  if (!badge) return;
  if (!liveAddress) {
    badge.textContent = "Connect Phantom or Solflare for a live balance";
    return;
  }
  try {
    const data = await api("/api/live-balance?address=" + encodeURIComponent(liveAddress));
    liveAt = Date.now();
    const equity = document.getElementById("equity");
    if (data.ok && equity) equity.textContent = Number(data.sol).toFixed(4) + " SOL";
    badge.textContent = data.ok
      ? "live · updated 0s ago · " + data.short
      : "live balance unavailable";
  } catch {
    badge.textContent = "live balance unavailable";
  }
}

function tickLiveBadge() {
  const badge = document.getElementById("liveBadge");
  if (!badge || !liveAt) return;
  const seconds = Math.max(0, Math.round((Date.now() - liveAt) / 1000));
  if (badge.textContent.startsWith("live ·")) {
    badge.textContent = badge.textContent.replace(/updated \d+s ago/, "updated " + seconds + "s ago");
  }
}

async function connectChoice(choice) {
  if (!window.ValhallaWallet) {
    say("The wallet script did not load.");
    return;
  }
  const linked = await window.ValhallaWallet.connect(choice);
  liveAddress = linked.address;
  document.getElementById("walletPanel").textContent = "Connected " + linked.short + ". Read-only.";
  await api("/api/watch", { address: linked.address });
  await refreshLive();
}

document.getElementById("btnPhantom")?.addEventListener("click", () => connectChoice("phantom").catch((err) => say(err.message)));
document.getElementById("btnSolflare")?.addEventListener("click", () => connectChoice("solflare").catch((err) => say(err.message)));
document.getElementById("btnDisconnect")?.addEventListener("click", async () => {
  liveAddress = "";
  liveAt = 0;
  document.getElementById("walletPanel").textContent = "Disconnected.";
  const equity = document.getElementById("equity");
  if (equity) equity.textContent = "—";
  await refreshLive();
});
setInterval(() => {
  tickLiveBadge();
  if (liveAddress && document.visibilityState !== "hidden") refreshLive();
}, 5000);
window.addEventListener("focus", () => refreshLive());

document.getElementById("btnApiTest")?.addEventListener("click", () => {
  say("Test stays on this PC. Keys are not sent to TokenJunction.");
});
document.getElementById("btnApiSave")?.addEventListener("click", async () => {
  const pairs = [
    ["HELIUS_API_KEY", "apiHelius"],
    ["BIRDEYE_API_KEY", "apiBirdeye"],
    ["TELEGRAM_BOT_TOKEN", "apiTelegram"],
    ["GOOGLE_GENERATIVE_AI_API_KEY", "apiBrain"],
    ["VALHALLA_BRAIN_URL", "apiBrainUrl"],
    ["VALHALLA_BRAIN_KEY", "apiBrainKey"],
  ];
  for (const [name, id] of pairs) {
    const value = document.getElementById(id).value.trim();
    if (!value) continue;
    await api("/api/keys", { name, value });
    document.getElementById(id).value = "";
  }
  say("Saved on this PC. You can skip any key.");
});

document.getElementById("controlsBtn").addEventListener("click", () => {
  const drawer = document.getElementById("drawer");
  drawer.hidden = !drawer.hidden;
});

async function bootGate() {
  try {
    const meta = await fetch("/api/meta").then((r) => r.json());
    if (meta.login) {
      document.getElementById("gate").hidden = false;
      return;
    }
    if (meta.needsSetup) openWizard(meta);
    else fillSettings(meta);
    loadConnections();
    loadRepair();
    loadBrain();
    loadPro();
  } catch {
    document.getElementById("gate").hidden = false;
  }
}

document.getElementById("gateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/login", {
      accessCode: document.getElementById("gateCode").value,
      password: document.getElementById("gatePass").value,
    });
    document.getElementById("gate").hidden = true;
    refreshDeskAd();
    refreshOffer();
    bootGate();
    loadConnections();
  } catch (err) {
    document.getElementById("gateErr").textContent = err.message;
  }
});

async function loadPro() {
  const host = document.getElementById("proPanel");
  if (!host) return;
  const data = await api("/api/license");
  const plan = await api("/api/plan").catch(() => ({}));
  host.innerHTML = "<div>" + (data.pro ? "Pro is on." : "Pro is off.") + " " + data.price + "</div>" +
    "<div>" + (plan.trialDays || 15) + " day free Pro trial. Not a promise of profit.</div>" +
    "<div>" + (data.tail || "No license key saved.") + "</div>" +
    "<div>" + data.note + "</div>" +
    "<label>License key</label><input id=\"licenseKey\" type=\"password\" autocomplete=\"off\"/>" +
    "<button type=\"button\" id=\"btnLicense\">Activate Pro</button>";
  if (data.checkoutUrl) {
    const go = document.createElement("a");
    go.id = "btnGoPro";
    go.textContent = "Go Pro";
    go.href = data.checkoutUrl;
    go.target = "_blank";
    go.rel = "noopener";
    host.appendChild(go);
    const upgrade = document.createElement("a");
    upgrade.id = "btnUpgrade";
    upgrade.textContent = "Upgrade";
    upgrade.href = data.portalCheckoutUrl || data.checkoutUrl;
    upgrade.target = "_blank";
    upgrade.rel = "noopener";
    host.appendChild(upgrade);
  }
  document.getElementById("btnLicense").addEventListener("click", async () => {
    const key = document.getElementById("licenseKey").value;
    document.getElementById("licenseKey").value = "";
    try {
      const saved = await api("/api/license/activate", { key, instanceName: "valhalla-desk" });
      say(saved.pro ? "Pro is on. The desk still cannot send or withdraw." : "Pro stayed off.");
    } catch (err) {
      say(err instanceof Error ? err.message : "License was not accepted.");
    }
    loadPro();
  });
}

async function loadBrain() {
  const host = document.getElementById("brainPanel");
  if (!host) return;
  const data = await api("/api/brain");
  host.innerHTML = "<div>" + data.provider + " · " + data.model + " · $" + Number(data.budgetUsd).toFixed(2) + " left</div>" +
    "<label>Provider</label><select id=\"brainProvider\"><option>gemini</option><option>openai</option><option>anthropic</option><option>grok</option><option>openrouter</option><option>ollama</option></select>" +
    "<label>Key</label><input id=\"brainKey\" type=\"password\" autocomplete=\"off\"/>" +
    "<label>PC password</label><input id=\"brainPass\" type=\"password\" autocomplete=\"off\"/>" +
    "<div class=\"rowbtns\"><button type=\"button\" id=\"saveBrain\">SAVE PROVIDER</button><button type=\"button\" id=\"tuneBrain\">SUGGEST TIGHTER</button><button type=\"button\" id=\"confirmTune\">CONFIRM</button><button type=\"button\" id=\"rollbackBrain\">ROLLBACK</button></div>";
  document.getElementById("brainProvider").value = data.provider || "gemini";
  document.getElementById("saveBrain").onclick = async () => {
    await api("/api/brain/provider", {
      provider: document.getElementById("brainProvider").value,
      secret: document.getElementById("brainKey").value,
      password: document.getElementById("brainPass").value,
    });
    document.getElementById("brainKey").value = "";
    loadBrain();
  };
  document.getElementById("tuneBrain").onclick = async () => {
    const result = await api("/api/brain/tune", { confirm: false });
    say(result.message);
  };
  document.getElementById("confirmTune").onclick = async () => {
    const result = await api("/api/brain/tune", { confirm: true });
    say(result.message);
  };
  document.getElementById("rollbackBrain").onclick = async () => {
    const result = await api("/api/brain/rollback", {});
    say(result.message);
  };
}

async function loadRepair() {
  const host = document.getElementById("repairPanel");
  if (!host) return;
  const data = await api("/api/self-repair");
  const health = data.health || {};
  const lines = (data.events || []).slice(0, 6).map((row) =>
    row.title + " · " + row.before + " → " + row.after
  ).join("<br>");
  host.innerHTML = "<div>Health " + (health.score ?? "—") + " " + (health.label || "") + "</div>" +
    "<div style=\"color:#7a7468;margin-top:6px\">" + (lines || "No incidents yet.") + "</div>" +
    "<div style=\"margin-top:6px\">" + ((data.proposal && data.proposal.summary) || "") + "</div>" +
    "<button type=\"button\" id=\"confirmRepair\">CONFIRM REPAIR</button>";
  const button = document.getElementById("confirmRepair");
  if (button) button.onclick = async () => {
    const result = await api("/api/self-repair/confirm", { confirm: true });
    say(result.message);
    loadRepair();
  };
}

async function loadConnections() {
  const host = document.getElementById("connectionsPanel");
  if (!host) return;
  const data = await api("/api/connections");
  host.innerHTML = (data.connections || []).map((row) => {
    return "<div style=\"margin-top:8px\"><b>" + row.label + "</b> · " + row.state +
      "<div class=\"rowbtns\">" +
      (row.needsKey ? "<input id=\"key-" + row.id + "\" type=\"password\" autocomplete=\"off\" placeholder=\"key\"/>" : "") +
      "<input id=\"pw-" + row.id + "\" type=\"password\" autocomplete=\"off\" placeholder=\"PC password\"/>" +
      "<button type=\"button\" data-connect=\"" + row.id + "\">CONNECT</button>" +
      "<button type=\"button\" data-test=\"" + row.id + "\">TEST</button>" +
      "<button type=\"button\" data-off=\"" + row.id + "\">DISCONNECT</button>" +
      "</div><div style=\"color:#7a7468\">" + (row.lastMessage || "") + "</div></div>";
  }).join("");
  host.querySelectorAll("[data-connect]").forEach((button) => {
    button.onclick = async () => {
      const id = button.getAttribute("data-connect");
      const secretEl = document.getElementById("key-" + id);
      await api("/api/connections/connect", {
        id,
        secret: secretEl ? secretEl.value : "",
        password: document.getElementById("pw-" + id).value,
      });
      if (secretEl) secretEl.value = "";
      loadConnections();
    };
  });
  host.querySelectorAll("[data-test]").forEach((button) => {
    button.onclick = async () => {
      const result = await api("/api/connections/test", { id: button.getAttribute("data-test") });
      say(result.message);
      loadConnections();
    };
  });
  host.querySelectorAll("[data-off]").forEach((button) => {
    button.onclick = async () => {
      await api("/api/connections/disconnect", { id: button.getAttribute("data-off") });
      loadConnections();
    };
  });
}

function fillSettings(meta) {
  const host = document.getElementById("settingsPanel");
  const s = meta.settings || {};
  host.innerHTML =
    "<label>Preset</label><select id=\"preset\"><option>safe</option><option>balanced</option><option>aggressive</option></select>" +
    "<label>Min buy SOL</label><input id=\"ticketMinSol\" value=\"" + (s.ticketMinSol ?? "") + "\"/>" +
    "<label>Max buy SOL</label><input id=\"ticketMaxSol\" value=\"" + (s.ticketMaxSol ?? "") + "\"/>" +
    "<label>Lanes</label><input id=\"lanes\" value=\"" + (s.lanes ?? "") + "\"/>" +
    "<label>Stop-loss (fraction, e.g. -0.08)</label><input id=\"stopLossPct\" value=\"" + (s.stopLossPct ?? "") + "\"/>" +
    "<label>Take-profit fraction</label><input id=\"takeProfitPct\" value=\"" + (s.takeProfitPct ?? "") + "\"/>" +
    "<label>Max hold minutes</label><input id=\"maxHoldMin\" value=\"" + (s.maxHoldMin ?? "") + "\"/>" +
    "<label>Cooldown minutes</label><input id=\"cooldownMin\" value=\"" + (s.cooldownMin ?? "") + "\"/>" +
    "<label>Daily loss fraction</label><input id=\"dailyLossPct\" value=\"" + (s.dailyLossPct ?? "") + "\"/>" +
    "<label>Run until (ISO time or blank)</label><input id=\"runUntil\" value=\"" + (s.runUntil || "") + "\"/>" +
    "<div class=\"rowbtns\"><button type=\"button\" id=\"saveSettings\">SAVE</button></div>" +
    "<label>Google AI Studio key</label><input id=\"googleKey\" type=\"password\" autocomplete=\"off\" placeholder=\"" + (meta.keys && meta.keys.google ? "saved" : "not set") + "\"/>" +
    "<label>Helius key</label><input id=\"heliusKey\" type=\"password\" autocomplete=\"off\" placeholder=\"" + (meta.keys && meta.keys.helius ? "saved" : "not set") + "\"/>" +
    "<div class=\"rowbtns\"><button type=\"button\" id=\"saveKeys\">SAVE KEYS</button><button type=\"button\" id=\"btnBackup\">BACKUP</button></div>" +
    "<label>Restore backup JSON</label><textarea id=\"restoreBox\" rows=\"3\"></textarea>" +
    "<button type=\"button\" id=\"btnRestore\">RESTORE</button>";
  document.getElementById("preset").value = s.preset || "balanced";
  document.getElementById("saveSettings").onclick = saveSettings;
  document.getElementById("saveKeys").onclick = saveKeys;
  document.getElementById("btnBackup").onclick = backup;
  document.getElementById("btnRestore").onclick = restore;
  const wallet = document.getElementById("walletPanel");
  wallet.innerHTML =
    "<div>mode " + (meta.walletMode || "none") + " · " + (meta.pubkey || "—") + "</div>" +
    "<div class=\"rowbtns\"><button type=\"button\" id=\"btnLock\">LOCK</button><button type=\"button\" id=\"btnUnlock\">UNLOCK</button></div>" +
    "<label>Wallet password</label><input id=\"walletPass\" type=\"password\" autocomplete=\"off\"/>" +
    "<label>New password</label><input id=\"newPass\" type=\"password\" autocomplete=\"off\"/>" +
    "<button type=\"button\" id=\"btnPass\">CHANGE PASSWORD</button>" +
    "<div id=\"qrbox\" class=\"qrbox\"></div>";
  document.getElementById("btnLock").onclick = () => api("/api/wallet/lock", {}).then((r) => say(r.message));
  document.getElementById("btnUnlock").onclick = () =>
    api("/api/wallet/unlock", { password: document.getElementById("walletPass").value }).then((r) => say(r.message));
  document.getElementById("btnPass").onclick = () =>
    api("/api/wallet/password", { password: document.getElementById("newPass").value }).then((r) => say(r.message));
  fetch("/api/qr").then((r) => r.json()).then((qr) => {
    const box = document.getElementById("qrbox");
    if (!box) return;
    box.innerHTML = (qr.svg || "") + "<div style=\"font-size:11px;word-break:break-all\">" + (qr.address || "Create a wallet to fund it.") + "</div>";
  }).catch(() => undefined);
}

async function saveSettings() {
  const settings = {
    preset: document.getElementById("preset").value,
    ticketMinSol: Number(document.getElementById("ticketMinSol").value),
    ticketMaxSol: Number(document.getElementById("ticketMaxSol").value),
    lanes: Number(document.getElementById("lanes").value),
    stopLossPct: Number(document.getElementById("stopLossPct").value),
    takeProfitPct: Number(document.getElementById("takeProfitPct").value),
    maxHoldMin: Number(document.getElementById("maxHoldMin").value),
    cooldownMin: Number(document.getElementById("cooldownMin").value),
    dailyLossPct: Number(document.getElementById("dailyLossPct").value),
    runUntil: document.getElementById("runUntil").value || null,
  };
  let result = await api("/api/settings", { settings });
  if (result.pending && confirm("Positions are open. Apply the new settings now?")) {
    result = await api("/api/settings", { settings, confirmNow: true });
  }
  say(result.message || "saved");
}

async function saveKeys() {
  const google = document.getElementById("googleKey").value.trim();
  const helius = document.getElementById("heliusKey").value.trim();
  if (google) say((await api("/api/keys", { name: "GOOGLE_GENERATIVE_AI_API_KEY", value: google })).message);
  if (helius) say((await api("/api/keys", { name: "HELIUS_API_KEY", value: helius })).message);
  document.getElementById("googleKey").value = "";
  document.getElementById("heliusKey").value = "";
}

async function backup() {
  const data = await api("/api/backup", { includeEncryptedWallet: confirm("Include the encrypted wallet file? The key stays encrypted.") });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "valhalla-backup.json";
  a.click();
}

async function restore() {
  const backup = JSON.parse(document.getElementById("restoreBox").value);
  say((await api("/api/restore", { backup })).message);
}

function openWizard() {
  const wiz = document.getElementById("wizard");
  wiz.hidden = false;
  const body = document.getElementById("wizBody");
  body.innerHTML =
    "<p class=\"warn\">Back up the secret once. This desk cannot show it again. There is no withdraw button.</p>" +
    "<label>Password (8+ characters)</label><input id=\"wizPass\" type=\"password\" style=\"width:100%;margin:6px 0;background:#050507;color:#f2ead8;border:1px solid #1c1a16;padding:8px\"/>" +
    "<div class=\"rowbtns\"><button type=\"button\" id=\"wizCreate\">CREATE BOT WALLET</button></div>" +
    "<label>Or paste a private key</label><input id=\"wizSecret\" type=\"password\" autocomplete=\"off\" style=\"width:100%;margin:6px 0;background:#050507;color:#f2ead8;border:1px solid #1c1a16;padding:8px\"/>" +
    "<button type=\"button\" id=\"wizImport\">IMPORT</button>" +
    "<div id=\"wizOut\"></div>";
  document.getElementById("wizCreate").onclick = async () => {
    const created = await api("/api/wallet/create", { password: document.getElementById("wizPass").value });
    showBackup(created);
  };
  document.getElementById("wizImport").onclick = async () => {
    const created = await api("/api/wallet/import", {
      password: document.getElementById("wizPass").value,
      secret: document.getElementById("wizSecret").value,
    });
    document.getElementById("wizSecret").value = "";
    showBackup(created);
  };
}

function showBackup(created) {
  const out = document.getElementById("wizOut");
  const secret = created.backupOnce
    ? "<p class=\"warn\">Write this down now. It will not be shown again.</p><textarea readonly rows=\"3\" style=\"width:100%\">" + created.backupOnce + "</textarea>"
    : "<p>Imported. The key is encrypted and hidden.</p>";
  out.innerHTML = secret +
    "<p>Fund this address from your own wallet app:</p><div style=\"word-break:break-all\">" + created.publicKey + "</div>" +
    "<div id=\"wizQr\" class=\"qrbox\"></div>" +
    "<label>Preset</label><select id=\"wizPreset\"><option>safe</option><option selected>balanced</option><option>aggressive</option></select>" +
    "<button type=\"button\" id=\"wizGo\">GO</button>";
  fetch("/api/qr").then((r) => r.json()).then((qr) => {
    const box = document.getElementById("wizQr");
    if (box) box.innerHTML = qr.svg || "";
  }).catch(() => undefined);
  document.getElementById("wizGo").onclick = async () => {
    await api("/api/preset", { preset: document.getElementById("wizPreset").value });
    document.getElementById("wizard").hidden = true;
    say("Desk is read-only. Arm live only when you mean it.");
  };
}

document.getElementById("btnStart").onclick = () => api("/api/start", {}).then((r) => say(r.message));
document.getElementById("btnStop").onclick = () => api("/api/stop", {}).then((r) => say(r.message));
document.getElementById("btnPause").onclick = () => api("/api/pause", {}).then((r) => say(r.message));
document.getElementById("btnResume").onclick = () => api("/api/resume", {}).then((r) => say(r.message));
document.getElementById("btnLive").onclick = () => {
  const confirmText = prompt("Type CONFIRM LIVE to allow swaps from the bot wallet.");
  if (!confirmText) return;
  api("/api/live", { enabled: true, confirm: confirmText }).then((r) => say(r.message));
};
document.getElementById("btnRead").onclick = () => api("/api/live", { enabled: false }).then((r) => say(r.message));
document.getElementById("btnSellAll").onclick = () => {
  const confirmText = prompt("Type SELL ALL to close every open position back to SOL in this wallet.");
  if (!confirmText) return;
  api("/api/sell-all", { confirm: confirmText }).then((r) => say(r.message));
};
async function watchUpdates() {
  const banner = document.getElementById("updateBanner");
  if (!banner) return;
  try {
    const info = await api("/api/update");
    banner.hidden = !info.update;
    if (info.update) banner.textContent = info.prompt || "Restart to update";
  } catch {
    banner.hidden = true;
  }
}
document.getElementById("updateBanner")?.addEventListener("click", async () => {
  const banner = document.getElementById("updateBanner");
  if (banner) banner.textContent = "Checking the hash.";
  try {
    await api("/api/update/install", {});
  } catch (err) {
    if (banner) banner.textContent = err instanceof Error ? err.message : "Update stopped.";
  }
});
function refreshDeskAd() {
  const slot = document.getElementById("deskAd");
  const gate = document.getElementById("gate");
  if (!slot) return;
  const blocked = gate && !gate.hidden;
  if (blocked) {
    slot.hidden = true;
    return;
  }
  api("/api/plan").then((plan) => {
    const free = plan.tier === "free";
    slot.hidden = !free;
    if (!free || slot.dataset.loaded) return;
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6504655762357230";
    script.onload = () => {
      const ads = window.adsbygoogle || [];
      window.adsbygoogle = ads;
      ads.push({});
    };
    document.head.appendChild(script);
    slot.dataset.loaded = "1";
  }).catch(() => {
    slot.hidden = true;
  });
}
function refreshOffer() {
  const slot = document.getElementById("deskOffer");
  if (!slot) return;
  api("/api/offers?placement=portal").then((data) => {
    const offer = (data.offers || [])[0];
    const label = slot.querySelector("p");
    while (slot.lastChild && slot.lastChild !== label) slot.removeChild(slot.lastChild);
    if (!offer || !String(offer.url || "").startsWith("https://")) {
      slot.hidden = true;
      return;
    }
    slot.hidden = false;
    const link = document.createElement("a");
    link.href = offer.url;
    link.target = "_blank";
    link.rel = "sponsored noopener noreferrer";
    link.textContent = offer.partner + ": " + offer.title;
    link.addEventListener("click", () => {
      api("/api/offers/click", { id: offer.id, placement: "portal" }).catch(() => {});
    });
    const note = document.createElement("p");
    note.style.color = "#93a4ba";
    note.style.fontSize = "11px";
    note.textContent = (data.label || "Affiliate link · we may earn a commission") + ". Not trading advice.";
    slot.appendChild(link);
    slot.appendChild(note);
  }).catch(() => {
    slot.hidden = true;
  });
}
function refreshProTrades() {
  const node = document.getElementById("proTrades");
  if (!node) return;
  api("/api/pro-trades")
    .then((data) => {
      const left = Number(data.remaining);
      const allowance = Number(data.allowance) || 100;
      node.textContent = `Pro trades left: ${Number.isFinite(left) ? left : allowance}/${allowance}`;
    })
    .catch(() => {
      node.textContent = "Pro trades left: 100/100";
    });
}
refreshDeskAd();
refreshOffer();
refreshProTrades();
watchUpdates();
setInterval(watchUpdates, 6 * 60 * 60 * 1000);
document.getElementById("btnQueue").onclick = () =>
  api("/api/queue", { mint: document.getElementById("mintInput").value }).then((r) => say(r.message));
document.getElementById("btnSignal")?.addEventListener("click", async () => {
  const mint = document.getElementById("mintInput").value.trim();
  const out = document.getElementById("signalOut");
  try {
    const data = await api("/api/signal?mint=" + encodeURIComponent(mint));
    const flags = (data.flags || []).join(", ");
    if (out) out.textContent = "Score " + data.score + ". " + flags + ". " + (data.disclaimer || "") + (data.offer ? " " + data.offer : "");
  } catch (err) {
    if (out) out.textContent = err instanceof Error ? err.message : "Score failed. Nothing was sent.";
  }
});
document.getElementById("btnChat").onclick = async () => {
  const text = document.getElementById("chatInput").value;
  document.getElementById("chatInput").value = "";
  say((await api("/api/chat", { text })).message);
};
document.body.addEventListener("click", (event) => {
  const button = event.target.closest(".sell-one");
  if (!button) return;
  if (!confirm("Sell this position back to SOL in the bot wallet?")) return;
  api("/api/sell", { id: button.getAttribute("data-id") }).then((r) => say(r.message));
});

setInterval(() => {
  fetch("/api/log").then((r) => r.json()).then((data) => {
    const box = document.getElementById("crashLog");
    if (!box || !data.rows) return;
    box.textContent = data.rows.slice(0, 12).map((row) => row.t.slice(11, 19) + " " + row.text).join("\n");
  }).catch(() => undefined);
}, 4000);

bootGate();
