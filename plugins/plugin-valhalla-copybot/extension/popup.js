const desk = document.getElementById("desk");
const code = document.getElementById("code");
const status = document.getElementById("status");

function say(text) {
  status.textContent = text;
}

chrome.storage.local.get(["desk", "token"], (saved) => {
  if (saved.desk) desk.value = saved.desk;
  if (saved.token) loadState(saved.desk, saved.token);
});

function walletLink(which) {
  const page = desk.value.trim() || "https://valhalla-app.xyz/";
  const url = which === "phantom"
    ? "https://phantom.app/ul/browse/" + encodeURIComponent(page) + "?ref=valhalla"
    : "https://solflare.com/ul/v1/browse/" + encodeURIComponent(page);
  chrome.tabs.create({ url });
}
document.getElementById("open-phantom").addEventListener("click", () => walletLink("phantom"));
document.getElementById("open-solflare").addEventListener("click", () => walletLink("solflare"));

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
