/**
 * Script for the blocked-site interstitial page.
 *
 * Reads the blocked host from URL search params, fetches task context from
 * the LifeOps API, and polls for unblock so the page auto-redirects once
 * the user completes the required tasks.
 */

const POLL_INTERVAL_MS = 30_000;

interface RequiredTask {
  id?: string;
  title: string;
  completed: boolean;
}

interface BlockedHostResponse {
  blocked: boolean;
  host: string;
  groupKey: string | null;
  requiredTasks: RequiredTask[];
  websites: string[];
}

const params = new URLSearchParams(window.location.search);
const blockedUrl = params.get("url") || "Unknown site";
const blockedHost = params.get("host") || blockedUrl;
const apiBase = normalizeApiBase(params.get("api"));

const blockedSiteEl = document.getElementById("blockedSite");
const taskListEl = document.getElementById("taskList");
const openLifeOpsEl = document.getElementById("openLifeOps");

if (blockedSiteEl) {
  blockedSiteEl.textContent = blockedHost;
}

if (openLifeOpsEl) {
  if (apiBase) {
    openLifeOpsEl.setAttribute("href", apiBase.replace(/:\d+$/, ":2138"));
  } else {
    openLifeOpsEl.removeAttribute("href");
  }
}

function normalizeApiBase(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

function renderTasks(tasks: RequiredTask[]): void {
  if (!taskListEl) {
    return;
  }
  if (tasks.length === 0) {
    taskListEl.innerHTML =
      '<li><span class="status-dot"></span> Site is blocked by LifeOps policy</li>';
    return;
  }
  taskListEl.innerHTML = tasks
    .map(
      (task) =>
        `<li><span class="status-dot ${task.completed ? "completed" : ""}"></span>${escapeHtml(task.title)}</li>`,
    )
    .join("");
}

function renderFallback(): void {
  if (!taskListEl) {
    return;
  }
  taskListEl.innerHTML =
    '<li><span class="status-dot"></span> Complete your LifeOps tasks to unblock</li>';
}

async function fetchBlockingReason(): Promise<BlockedHostResponse | null> {
  if (!apiBase) {
    return null;
  }
  try {
    const resp = await fetch(
      `${apiBase}/api/website-blocker?host=${encodeURIComponent(blockedHost)}`,
    );
    if (!resp.ok) {
      return null;
    }
    return (await resp.json()) as BlockedHostResponse;
  } catch {
    return null;
  }
}

async function loadBlockingReason(): Promise<void> {
  const data = await fetchBlockingReason();
  if (data?.requiredTasks) {
    renderTasks(data.requiredTasks);
  } else {
    renderFallback();
  }
}

async function pollForUnblock(): Promise<void> {
  const data = await fetchBlockingReason();
  if (data && !data.blocked) {
    const target = blockedUrl.startsWith("http")
      ? blockedUrl
      : `https://${blockedUrl}`;
    window.location.href = target;
  }
}

void loadBlockingReason();

setInterval(() => {
  void pollForUnblock();
}, POLL_INTERVAL_MS);
