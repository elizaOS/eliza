const el = (id) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node;
};

const sessionIdEl = el("sessionId");
const autonomyStateEl = el("autonomyState");
const chatPane = el("chatPane");
const logsPane = el("logsPane");
const chatInput = el("chatInput");
const chatStatus = el("chatStatus");

let sessionId = null;

function nowTime() {
  return new Date().toLocaleTimeString();
}

function appendMessage(pane, who, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  const header = document.createElement("div");
  const whoSpan = document.createElement("span");
  whoSpan.className = "who";
  whoSpan.textContent = who;
  const timeSpan = document.createElement("span");
  timeSpan.className = "time";
  timeSpan.textContent = nowTime();
  header.appendChild(whoSpan);
  header.appendChild(timeSpan);
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  wrap.appendChild(header);
  wrap.appendChild(body);
  pane.appendChild(wrap);
  pane.scrollTop = pane.scrollHeight;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  return { ok: res.ok, json };
}

async function getJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  return { ok: res.ok, json };
}

async function refreshAutonomyStatus() {
  const { ok, json } = await getJson("/autonomy/status");
  if (!ok) {
    autonomyStateEl.textContent = `autonomy unavailable: ${json?.error ?? "unknown error"}`;
    return;
  }
  const enabled = json?.data?.status?.enabled === true;
  const running = json?.data?.status?.running === true;
  const thinking = json?.data?.status?.thinking === true;
  const interval = json?.data?.status?.interval ?? 0;
  const mode = json?.data?.mode ?? "";
  const targetRoomId = json?.data?.targetRoomId ?? "";
  autonomyStateEl.textContent = `enabled=${String(enabled)} running=${String(running)} thinking=${String(
    thinking,
  )} intervalMs=${String(interval)} mode=${String(mode)} targetRoomId=${String(targetRoomId)}`;
}

async function refreshConfig() {
  const { ok, json } = await getJson("/config");
  if (!ok) return;
  const hasOpenAi = json?.hasOpenAi === true;
  if (!hasOpenAi) {
    autonomyStateEl.textContent =
      "LLM not configured (set OPENAI_API_KEY). Chat will be limited; autonomy may not do useful work.";
  }
}

let lastLogIds = new Set();
async function refreshLogs() {
  const { ok, json } = await getJson("/autonomy/logs");
  if (!ok) return;
  const items = json?.data?.items ?? [];
  for (const item of items) {
    const id = item?.id ?? "";
    if (typeof id !== "string" || id.length === 0) continue;
    if (lastLogIds.has(id)) continue;
    lastLogIds.add(id);
    const text = String(item?.text ?? "");
    const source = String(item?.source ?? "autonomy");
    appendMessage(logsPane, source, text);
  }
}

el("btnSend").addEventListener("click", async () => {
  const msg = chatInput.value.trim();
  if (!msg) return;
  chatInput.value = "";
  appendMessage(chatPane, "You", msg);
  chatStatus.textContent = "sending...";
  const { ok, json } = await postJson("/chat", { message: msg, sessionId });
  if (!ok) {
    chatStatus.textContent = `error: ${json?.error ?? "unknown"}`;
    return;
  }
  sessionId = json?.sessionId ?? sessionId;
  sessionIdEl.textContent = sessionId ? sessionId : "(new)";
  appendMessage(chatPane, "Agent", String(json?.response ?? ""));
  chatStatus.textContent = "";
  await refreshAutonomyStatus();
});

el("btnAutonomyEnable").addEventListener("click", async () => {
  const { ok, json } = await postJson("/autonomy/enable", {});
  if (!ok) {
    autonomyStateEl.textContent = `enable failed: ${json?.error ?? "unknown"}`;
    return;
  }
  await refreshAutonomyStatus();
});

el("btnAutonomyDisable").addEventListener("click", async () => {
  const { ok, json } = await postJson("/autonomy/disable", {});
  if (!ok) {
    autonomyStateEl.textContent = `disable failed: ${json?.error ?? "unknown"}`;
    return;
  }
  await refreshAutonomyStatus();
});

// Initial boot
await refreshConfig();
await refreshAutonomyStatus();
await refreshLogs();
setInterval(refreshAutonomyStatus, 3000);
setInterval(refreshLogs, 2500);

