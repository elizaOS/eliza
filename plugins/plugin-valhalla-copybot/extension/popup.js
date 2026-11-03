const desk = document.getElementById("desk");
const code = document.getElementById("code");
const status = document.getElementById("status");

function say(text) {
  status.textContent = text;
}

chrome.storage.local.get(["desk", "token", "brainApi", "brainKey"], (saved) => {
  if (saved.desk) desk.value = saved.desk;
  if (saved.token) loadState(saved.desk, saved.token);
  const brainApi = document.getElementById("brain-api");
  const brainKey = document.getElementById("brain-key");
  if (brainApi && saved.brainApi) brainApi.value = saved.brainApi;
  if (brainKey && saved.brainKey) brainKey.value = saved.brainKey;
});

function walletLink(which) {
  const page = desk.value.trim() || "https://valhalla-app.xyz/";
  const url = which === "phantom"
    ? "https://phantom.app/ul/browse/" + encodeURIComponent(page) + "?ref=valhalla"
    : "https://solflare.com/ul/v1/browse/" + encodeURIComponent(page);
  chrome.tabs.create({ url });
}
document.getElementById("open-phantom")?.addEventListener("click", () => walletLink("phantom"));
document.getElementById("open-solflare")?.addEventListener("click", () => walletLink("solflare"));

document.getElementById("go-pro")?.addEventListener("click", () => {
  const url = new URL("https://valhalla.lemonsqueezy.com/checkout/buy/4f959b69-81ca-45ca-8c3d-c80347b6b439");
  url.searchParams.set("checkout[custom][source]", "extension");
  chrome.tabs.create({ url: url.toString() });
});

document.getElementById("pair").addEventListener("click", async () => {
  const base = desk.value.trim().replace(/\/$/, "");
  if (!base.startsWith("http://127.0.0.1") && !base.startsWith("http://localhost")) {
    say("Use the desk on this computer. The extension will not call a public host.");
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
  const brainApi = document.getElementById("brain-api").value.trim();
  const brainKey = document.getElementById("brain-key").value.trim();
  await chrome.storage.local.set({ brainApi, brainKey });
  const saved = await chrome.storage.local.get(["desk", "token"]);
  if (saved.desk) {
    try {
      const response = await fetch(`${saved.desk.replace(/\/$/, "")}/api/signal?mint=${encodeURIComponent(mint)}`);
      if (response.ok) {
        const body = await response.json();
        out.textContent = `Score ${body.score}. ${(body.flags || []).join(", ")}. ${body.disclaimer || "Not financial advice."}`;
        return;
      }
    } catch {
      // The desk did not answer. Try the Brain API, then the local score.
    }
  }
  if (brainApi.startsWith("https://") && brainKey) {
    try {
      const origin = new URL(brainApi).origin + "/*";
      const allowed = await chrome.permissions.contains({ origins: [origin] });
      if (!allowed) await chrome.permissions.request({ origins: [origin] });
      const response = await fetch(`${brainApi.replace(/\/$/, "")}/v1/score/${encodeURIComponent(mint)}`, {
        headers: { authorization: `Bearer ${brainKey}` },
      });
      if (response.ok) {
        const body = await response.json();
        out.textContent = `Score ${body.score}. ${(body.flags || []).join(", ")}. Not financial advice.`;
        return;
      }
    } catch {
      // The API did not answer. Use the local score.
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
  const house = document.getElementById("house");
  if (house) house.hidden = false;
}
