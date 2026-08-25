/**
 * Controller for the block interstitial (blocked.html) shown when
 * declarativeNetRequest redirects a blocked site. Reads the blocked URL/host
 * and agent base from the query string, then polls the agent for the group's
 * required tasks and links back to LifeOps so the user can clear the block.
 */
import {
  loadCompanionConfig,
  resolveTrustedBlockedPageApiBase,
} from "../src/storage";
import {
  normalizeHostForComparison,
  normalizeNavigableUrlForHost,
} from "../src/url";

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
const blockedUrl = params.get("url");
const blockedHost =
  normalizeHostForComparison(params.get("host")) ??
  normalizeHostForComparison(blockedUrl) ??
  "Unknown site";
const requestedApiBase = params.get("api");
let apiBase: string | null = null;

const blockedSiteEl = document.getElementById("blockedSite");
const taskListEl = document.getElementById("taskList");
const openLifeOpsEl = document.getElementById("openLifeOps");

if (blockedSiteEl) {
  blockedSiteEl.textContent = blockedHost;
}

openLifeOpsEl?.removeAttribute("href");

function appendTask(title: string, completed = false): void {
  if (!taskListEl) return;
  const item = document.createElement("li");
  const status = document.createElement("span");
  status.className = completed ? "status-dot completed" : "status-dot";
  item.append(status, document.createTextNode(title));
  taskListEl.append(item);
}

function renderTasks(tasks: RequiredTask[]): void {
  if (!taskListEl) {
    return;
  }
  taskListEl.replaceChildren();
  if (tasks.length === 0) {
    appendTask("Site is blocked by LifeOps policy");
    return;
  }
  for (const task of tasks) {
    appendTask(task.title, task.completed);
  }
}

function renderFallback(): void {
  if (!taskListEl) {
    return;
  }
  taskListEl.replaceChildren();
  appendTask("Complete your LifeOps tasks to unblock");
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
    // error-policy:J4 A failed policy lookup keeps the interstitial visibly
    // degraded and does not navigate or claim that the site is unblocked.
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
    const target = normalizeNavigableUrlForHost(blockedUrl, blockedHost);
    if (target) {
      window.location.href = target;
    }
  }
}

async function initializeBlockedPage(): Promise<void> {
  const pairedConfig = await loadCompanionConfig();
  apiBase = resolveTrustedBlockedPageApiBase(requestedApiBase, pairedConfig);
  if (apiBase && openLifeOpsEl) {
    openLifeOpsEl.setAttribute("href", apiBase.replace(/:\d+$/, ":2138"));
  }
  await loadBlockingReason();
  if (apiBase) {
    setInterval(() => {
      void pollForUnblock();
    }, POLL_INTERVAL_MS);
  }
}

void initializeBlockedPage();
