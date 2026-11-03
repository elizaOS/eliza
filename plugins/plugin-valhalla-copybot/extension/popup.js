const desk = document.getElementById("desk");
const code = document.getElementById("code");
const status = document.getElementById("status");

function say(text) {
  if (status) status.textContent = text;
}

chrome.storage.local.get(["desk", "token"], (saved) => {
  if (saved.desk && desk) desk.value = saved.desk;
  if (saved.token && saved.desk) loadState(saved.desk, saved.token);
});

function walletHref(which) {
  const page = (desk && desk.value.trim()) || "https://valhalla-app.xyz/";
  if (which === "phantom") {
    return "https://phantom.app/ul/browse/" + encodeURIComponent(page) + "?ref=valhalla";
  }
  return "https://solflare.com/ul/v1/browse/" + encodeURIComponent(page);
}
document.getElementById("open-phantom")?.addEventListener("click", (event) => {
  event.preventDefault();
  window.open(walletHref("phantom"));
});
document.getElementById("open-solflare")?.addEventListener("click", (event) => {
  event.preventDefault();
  window.open(walletHref("solflare"));
});

async function allowDesk(base) {
  const origin = new URL(base).origin + "/*";
  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;
  return chrome.permissions.request({ origins: [origin] });
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
      const response = await fetch(`${saved.desk.replace(/\/$/, "")}/api/signal?mint=${encodeURIComponent(mint)}`);
      if (response.ok) {
        const body = await response.json();
        out.textContent = `Score ${body.score}. ${(body.flags || []).join(", ")}. ${body.disclaimer || "Not financial advice."}`;
        return;
      }
    } catch {
      // The desk did not answer. Use the local score.
    }
  }
  const local = localScore(mint);
  out.textContent = `Score ${local.score}. ${local.flags.join(", ")}.`;
});

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
  say(`${row.status || "Desk answered."}\n${row.pnl || ""}\n${row.positions || ""}\nRead-only. No send or withdraw.`);
}
