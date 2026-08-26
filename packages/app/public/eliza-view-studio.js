/**
 * Runs the local Eliza comparison studio using only canonical app routes and live registry entries.
 * Both frames load the same running application; the proposal receives one same-origin stylesheet.
 */

const catalogRouteGroups = [
  {
    name: "Core",
    views: [
      { label: "Home & Chat", path: "/chat", icon: "message-circle" },
      { label: "Phone", path: "/phone", icon: "phone" },
      { label: "Messages", path: "/messages", icon: "message" },
      { label: "Contacts", path: "/contacts", icon: "users" },
      { label: "Camera", path: "/camera", icon: "camera" },
      { label: "Browser", path: "/browser", icon: "compass" },
      { label: "Live stream", path: "/stream", icon: "pulse" },
      { label: "Pendant transcript", path: "/pendant/transcript", icon: "mic" },
      { label: "Views", path: "/views", icon: "grid" },
      { label: "Apps", path: "/apps", icon: "apps" },
      { label: "Background", path: "/background", icon: "image" },
    ],
  },
  {
    name: "Character",
    views: [
      { label: "Personality", path: "/character", icon: "user" },
      { label: "Choose character", path: "/character/select", icon: "users" },
      { label: "Knowledge", path: "/character/documents", icon: "file" },
      { label: "Character skills", path: "/character/skills", icon: "spark" },
      { label: "Experience", path: "/character/experience", icon: "timeline" },
      { label: "Relationships", path: "/apps/relationships", icon: "relationships" },
      { label: "Rolodex", path: "/rolodex", icon: "book" },
    ],
  },
  {
    name: "Work & life",
    views: [
      { label: "Notes", path: "/notes", icon: "note" },
      { label: "Calendar", path: "/calendar", icon: "calendar" },
      { label: "Automations", path: "/automations", icon: "bolt" },
      { label: "Projects", path: "/apps/tasks", icon: "folder" },
      { label: "Task coordinator", path: "/task-coordinator", icon: "check" },
      { label: "Orchestrator", path: "/orchestrator", icon: "nodes" },
      { label: "Cockpit", path: "/cockpit", icon: "sliders" },
      { label: "Inbox", path: "/inbox", icon: "inbox" },
      { label: "Goals", path: "/goals", icon: "target" },
      { label: "Focus", path: "/focus", icon: "focus" },
      { label: "Todos", path: "/todos", icon: "check" },
      { label: "Health", path: "/health", icon: "heart" },
      { label: "Finances", path: "/finances", icon: "chart" },
      { label: "Wallet", path: "/wallet", icon: "wallet" },
    ],
  },
  {
    name: "Developer",
    views: [
      { label: "Files", path: "/apps/files", icon: "files" },
      { label: "Plugins", path: "/apps/plugins", icon: "plug" },
      { label: "Skills", path: "/apps/skills", icon: "spark" },
      { label: "Trajectories", path: "/apps/trajectories", icon: "route" },
      { label: "Transcripts", path: "/apps/transcripts", icon: "transcript" },
      { label: "Memories", path: "/apps/memories", icon: "memory" },
      { label: "Runtime", path: "/apps/runtime", icon: "runtime" },
      { label: "Database", path: "/apps/database", icon: "database" },
      { label: "Logs", path: "/apps/logs", icon: "list" },
      { label: "LifeOps test", path: "/lifeops-live-test", icon: "pulse" },
      { label: "Desktop", path: "/desktop", icon: "desktop" },
      { label: "Cloud apps", path: "/cloud-apps", icon: "cloud" },
    ],
  },
  {
    name: "System",
    views: [
      { label: "Vault", path: "/vault", icon: "lock" },
      { label: "Settings", path: "/settings", icon: "settings" },
      { label: "Voice settings", path: "/settings/voice", icon: "mic" },
    ],
  },
];

const iconPaths = {
  "message-circle": '<path d="M3 4.5h14v10H8l-4 3v-3H3z"/>',
  message: '<path d="M3 5h14v10H3zM3 6l7 5 7-5"/>',
  phone: '<path d="M6 3 4 5c0 5.5 5.5 11 11 11l2-2-3-3-2 2c-2.5-1-4-2.5-5-5l2-2z"/>',
  compass:
    '<circle cx="10" cy="10" r="7"/><path d="m12.5 7.5-1.4 3.6-3.6 1.4 1.4-3.6z"/>',
  camera:
    '<rect x="3" y="5.5" width="14" height="10" rx="2"/><circle cx="10" cy="10.5" r="3"/><path d="m7 5.5 1-2h4l1 2"/>',
  grid: '<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/>',
  apps: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M8 8v9"/>',
  image:
    '<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7" cy="8" r="1.2"/><path d="m4 14 4-4 3 3 2-2 3 3"/>',
  user: '<circle cx="10" cy="7" r="3"/><path d="M4 17c.5-3.2 2.5-5 6-5s5.5 1.8 6 5"/>',
  users:
    '<circle cx="8" cy="7" r="2.5"/><circle cx="14" cy="8" r="2"/><path d="M3.5 16c.4-3 1.9-4.5 4.5-4.5s4.1 1.5 4.5 4.5M12 12c2.6 0 4.1 1.3 4.5 4"/>',
  file: '<path d="M5 2.5h7l3 3V17H5z"/><path d="M12 2.5v3h3M7.5 9h5M7.5 12h5"/>',
  files: '<path d="M6 2.5h7l3 3V16H6zM13 2.5v3h3"/><path d="M4 6H3v11h9v-1"/>',
  spark: '<path d="m10 2 1.5 5.5L17 9l-5.5 1.5L10 16l-1.5-5.5L3 9l5.5-1.5z"/>',
  timeline:
    '<path d="M5 3v14M5 6h6M5 11h9M5 16h5"/><circle cx="5" cy="6" r="1"/><circle cx="5" cy="11" r="1"/><circle cx="5" cy="16" r="1"/>',
  relationships: '<circle cx="6" cy="10" r="3"/><circle cx="14" cy="10" r="3"/><path d="M9 10h2"/>',
  book: '<path d="M3 4.5h5.5c1 0 1.5.5 1.5 1.5v11c0-1-.5-1.5-1.5-1.5H3zM17 4.5h-5.5c-1 0-1.5.5-1.5 1.5v11c0-1 .5-1.5 1.5-1.5H17z"/>',
  note: '<path d="M4 3h12v14H4zM7 7h6M7 10h6M7 13h4"/>',
  calendar:
    '<rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M6 2.5v4M14 2.5v4M3 8h14"/>',
  bolt: '<path d="m11 2-6 9h5l-1 7 6-10h-5z"/>',
  folder: '<path d="M2.5 5.5h6l1.5 2h7.5v8.5H2.5z"/>',
  check: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="m6 10 2.5 2.5L14 7"/>',
  nodes:
    '<circle cx="5" cy="5" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="10" cy="15" r="2"/><path d="m6.8 5.2 6.2.6M6 6.7 9 13M14 7.8 11 13"/>',
  sliders:
    '<path d="M3 5h14M3 10h14M3 15h14"/><circle cx="7" cy="5" r="2"/><circle cx="13" cy="10" r="2"/><circle cx="9" cy="15" r="2"/>',
  inbox: '<path d="M3 4h14v12H3zM3 11h4l1.5 2h3L13 11h4"/>',
  target: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3"/><path d="m10 10 5-5"/>',
  focus: '<path d="M3 8V4a1 1 0 0 1 1-1h4M12 3h4a1 1 0 0 1 1 1v4M17 12v4a1 1 0 0 1-1 1h-4M8 17H4a1 1 0 0 1-1-1v-4"/>',
  heart:
    '<path d="M10 17S3 13 3 7.5A3.5 3.5 0 0 1 9.5 5L10 6l.5-1A3.5 3.5 0 0 1 17 7.5C17 13 10 17 10 17Z"/>',
  chart: '<path d="M3 17V3M3 17h14M6 14v-4M10 14V6M14 14V9"/>',
  wallet: '<path d="M3 5h12v11H3zM3 7h14v6h-5a2 2 0 0 1 0-4h5M13 11h.01"/>',
  plug: '<path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0zM10 15v3"/>',
  route: '<circle cx="5" cy="4" r="2"/><circle cx="15" cy="16" r="2"/><path d="M5 6v4c0 2 1 3 3 3h4c2 0 3 1 3 3"/>',
  transcript: '<path d="M4 3h12v14H4zM7 7h6M7 10h6M7 13h3"/>',
  memory: '<path d="M7 3h6v3h3v8h-3v3H7v-3H4V6h3zM7 7h6v6H7z"/>',
  runtime: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="m6 8 2 2-2 2M10 12h4"/>',
  database:
    '<ellipse cx="10" cy="5" rx="6" ry="2.5"/><path d="M4 5v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5"/>',
  list: '<path d="M7 5h10M7 10h10M7 15h10M3 5h.01M3 10h.01M3 15h.01"/>',
  pulse: '<path d="M2 10h4l2-5 4 10 2-5h4"/>',
  desktop: '<rect x="2.5" y="3.5" width="15" height="11" rx="1.5"/><path d="M7 17h6M10 14.5V17"/>',
  cloud: '<path d="M5 15h10a3 3 0 0 0 .4-6A5.5 5.5 0 0 0 5 7.5 3.8 3.8 0 0 0 5 15Z"/>',
  lock: '<rect x="4" y="8" width="12" height="9" rx="2"/><path d="M7 8V6a3 3 0 0 1 6 0v2"/>',
  settings:
    '<circle cx="10" cy="10" r="3"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4"/>',
  mic: '<rect x="7" y="2.5" width="6" height="10" rx="3"/><path d="M4.5 10a5.5 5.5 0 0 0 11 0M10 15.5V18M7 18h6"/>',
};

const root = document.getElementById("studioRoot");
const viewIndex = document.getElementById("viewIndex");
const viewSearch = document.getElementById("viewSearch");
const routeCount = document.getElementById("routeCount");
const currentFrame = document.getElementById("currentFrame");
const proposedFrame = document.getElementById("proposedFrame");
const comparison = document.getElementById("comparison");
const viewTitle = document.getElementById("viewTitle");
const viewMeta = document.getElementById("viewMeta");
const openLive = document.getElementById("openLive");
const comparisonRoute = document.getElementById("comparisonRoute");
const routeStatus = document.getElementById("routeStatus");
const currentState = document.getElementById("currentState");
const proposedState = document.getElementById("proposedState");
const registryStatus = document.getElementById("registryStatus");
const registryDot = document.getElementById("registryDot");
const rail = document.getElementById("viewRail");
const railOpen = document.getElementById("railOpen");
const workspace = document.querySelector(".workspace");
const resyncFrames = document.getElementById("resyncFrames");
const mobileRailQuery = window.matchMedia("(max-width: 820px)");

const catalogPathSet = new Set(
  catalogRouteGroups.flatMap((group) => group.views.map((view) => view.path)),
);
let registryViews = [];

function safeRoutePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

const requestedPath = safeRoutePath(new URLSearchParams(window.location.search).get("view"));
let selectedPath = requestedPath && catalogPathSet.has(requestedPath) ? requestedPath : "/notes";

function dynamicRegistryViews() {
  const byPath = new Map();
  for (const entry of registryViews) {
    if ((entry.viewType ?? "gui") !== "gui") continue;
    const path = safeRoutePath(entry.path);
    if (!path || catalogPathSet.has(path) || byPath.has(path)) continue;
    byPath.set(path, {
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : path,
      path,
      icon: "grid",
    });
  }
  return [...byPath.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function routeGroups() {
  const dynamic = dynamicRegistryViews();
  return dynamic.length
    ? [...catalogRouteGroups, { name: "Live registry", views: dynamic }]
    : catalogRouteGroups;
}

function allViews() {
  return routeGroups().flatMap((group) =>
    group.views.map((view) => ({ ...view, group: group.name })),
  );
}

function icon(name) {
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${iconPaths[name] || iconPaths.grid}</svg>`;
}

function registryEntriesForPath(path) {
  return registryViews.filter((entry) => safeRoutePath(entry.path) === path);
}

function routeAvailability(path) {
  const entries = registryEntriesForPath(path);
  if (!entries.length) {
    return {
      state: "route",
      label: "App route",
      detail: "This route is part of the app catalog and is not separately reported by the runtime registry.",
    };
  }

  const availableEntries = entries.filter((entry) => entry.available !== false);
  const owners = [...new Set(entries.map((entry) => entry.pluginName).filter(Boolean))];
  const ownerDetail = owners.length ? ` Reported by ${owners.join(", ")}.` : "";
  if (availableEntries.length) {
    return {
      state: "available",
      label: "Registered live",
      detail: `The runtime reports this GUI route available.${ownerDetail}`,
    };
  }
  return {
    state: "unavailable",
    label: "Registered, unavailable",
    detail: `The runtime knows this route but reports it unavailable in the current lane.${ownerDetail}`,
  };
}

function renderIndex(query = "") {
  const normalized = query.trim().toLowerCase();
  const groups = routeGroups();
  const visibleViews = groups.flatMap((group) =>
    group.views.filter(({ label, path }) =>
      `${label} ${path} ${group.name}`.toLowerCase().includes(normalized),
    ),
  );
  viewIndex.replaceChildren();

  for (const group of groups) {
    const matches = group.views.filter(({ label, path }) =>
      `${label} ${path} ${group.name}`.toLowerCase().includes(normalized),
    );
    if (!matches.length) continue;

    const section = document.createElement("section");
    section.className = "view-group";
    const heading = document.createElement("h2");
    heading.textContent = group.name;
    section.append(heading);

    for (const view of matches) {
      const availability = routeAvailability(view.path);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "view-link";
      button.dataset.path = view.path;
      button.setAttribute("aria-label", `${view.label}, ${availability.label}`);
      if (view.path === selectedPath) button.setAttribute("aria-current", "page");
      button.insertAdjacentHTML("afterbegin", icon(view.icon));

      const label = document.createElement("span");
      label.className = "view-link-label";
      label.textContent = view.label;
      button.append(label);

      const signal = document.createElement("span");
      signal.className = "route-signal";
      signal.dataset.state = availability.state;
      signal.title = availability.label;
      signal.setAttribute("aria-hidden", "true");
      button.append(signal);

      button.addEventListener("click", () => selectView(view.path));
      section.append(button);
    }

    viewIndex.append(section);
  }

  if (!visibleViews.length) {
    const empty = document.createElement("p");
    empty.className = "empty-index";
    empty.textContent = "No route matches that search.";
    viewIndex.append(empty);
  }

  const total = allViews().length;
  routeCount.textContent = normalized ? `${visibleViews.length} of ${total} routes` : `${total} real routes`;
}

function setFrameState(element, state, label) {
  element.dataset.state = state;
  element.textContent = label;
}

function frameUrl(path, mode) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("studio", mode);
  return `${url.pathname}${url.search}${url.hash}`;
}

function proposedThemeLink(frame) {
  try {
    const documentRoot = frame.contentDocument;
    if (!documentRoot?.documentElement || !documentRoot.head) {
      setFrameState(proposedState, "error", "Document unavailable");
      return;
    }
    documentRoot.documentElement.dataset.elizaStudioProposed = "true";
    const existing = documentRoot.getElementById("elizaStudioProposedTheme");
    if (existing) {
      setFrameState(proposedState, "ready", "Graphite applied");
      return;
    }

    const link = documentRoot.createElement("link");
    link.id = "elizaStudioProposedTheme";
    link.rel = "stylesheet";
    link.href = "/eliza-proposed-theme.css";
    link.addEventListener("load", () => {
      setFrameState(proposedState, "ready", "Graphite applied");
    });
    link.addEventListener("error", () => {
      setFrameState(proposedState, "error", "Theme failed");
    });
    documentRoot.head.append(link);
  } catch {
    setFrameState(proposedState, "error", "Theme unavailable");
  }
}

function updateSelectedView(view) {
  const availability = routeAvailability(view.path);
  viewTitle.textContent = view.label;
  viewMeta.textContent = `${view.group} · ${view.path} · ${availability.label}`;
  openLive.href = view.path;
  comparisonRoute.textContent = view.path;
  routeStatus.textContent = availability.detail;
}

function clearFrameDivergence() {
  root.dataset.diverged = "false";
}

function frameRoute(frame) {
  try {
    const url = new URL(frame.contentWindow.location.href);
    if (url.origin !== window.location.origin || url.protocol === "about:") return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function detectFrameDivergence() {
  const selectedRoute = new URL(selectedPath, window.location.origin).pathname;
  const currentRoute = frameRoute(currentFrame);
  const proposedRoute = frameRoute(proposedFrame);
  const currentDiverged = Boolean(currentRoute && currentRoute !== selectedRoute);
  const proposedDiverged = Boolean(proposedRoute && proposedRoute !== selectedRoute);
  root.dataset.diverged = String(currentDiverged || proposedDiverged);
  if (currentDiverged) {
    setFrameState(currentState, "error", `Different route · ${currentRoute}`);
  } else if (currentState.dataset.state === "error") {
    setFrameState(currentState, "ready", "Rendered");
  }
  if (proposedDiverged) {
    setFrameState(proposedState, "error", `Different route · ${proposedRoute}`);
  } else if (proposedState.dataset.state === "error") {
    setFrameState(proposedState, "ready", "Graphite applied");
  }
}

function selectView(path) {
  const view = allViews().find((item) => item.path === path);
  if (!view) return;
  selectedPath = path;
  clearFrameDivergence();
  const url = new URL(window.location.href);
  url.searchParams.set("view", path);
  window.history.replaceState({}, "", url);

  updateSelectedView(view);
  renderIndex(viewSearch.value);

  setFrameState(currentState, "loading", "Loading");
  setFrameState(proposedState, "loading", "Loading");
  currentFrame.src = frameUrl(view.path, "current");
  proposedFrame.src = frameUrl(view.path, "proposed");
  if (mobileRailQuery.matches) {
    setRailOpen(false, { restoreFocus: true });
  }
}

currentFrame.addEventListener("load", () => {
  setFrameState(currentState, "ready", "Rendered");
  window.setTimeout(detectFrameDivergence, 0);
});
currentFrame.addEventListener("error", () => {
  setFrameState(currentState, "error", "Load failed");
});

proposedFrame.addEventListener("load", () => {
  setFrameState(proposedState, "loading", "Applying graphite");
  proposedThemeLink(proposedFrame);
  window.setTimeout(detectFrameDivergence, 0);
});
proposedFrame.addEventListener("error", () => {
  setFrameState(proposedState, "error", "Load failed");
});

viewSearch.addEventListener("input", (event) => {
  renderIndex(event.currentTarget.value);
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    viewSearch.focus();
    viewSearch.select();
  }
  if (event.key === "Escape" && root.dataset.railOpen === "true") {
    setRailOpen(false, { restoreFocus: true });
  }
});

document.querySelectorAll("[data-viewport]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-viewport]").forEach((candidate) => {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    });
    comparison.dataset.viewport = button.dataset.viewport;
  });
});

document.querySelectorAll("[data-layout]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-layout]").forEach((candidate) => {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    });
    comparison.dataset.layout = button.dataset.layout;
  });
});

document.getElementById("reloadFrames").addEventListener("click", () => {
  setFrameState(currentState, "loading", "Reloading");
  setFrameState(proposedState, "loading", "Reloading");
  currentFrame.contentWindow?.location.reload();
  proposedFrame.contentWindow?.location.reload();
});

function syncRailAccessibility() {
  const mobile = mobileRailQuery.matches;
  const open = mobile && root.dataset.railOpen === "true";
  rail.inert = mobile && !open;
  workspace.inert = open;
  railOpen.setAttribute("aria-expanded", String(open));
  if (mobile) {
    rail.setAttribute("aria-hidden", String(!open));
    if (open) {
      rail.setAttribute("role", "dialog");
      rail.setAttribute("aria-modal", "true");
    } else {
      rail.removeAttribute("role");
      rail.removeAttribute("aria-modal");
    }
  } else {
    rail.removeAttribute("aria-hidden");
    rail.removeAttribute("role");
    rail.removeAttribute("aria-modal");
  }
}

function setRailOpen(open, { restoreFocus = false } = {}) {
  root.dataset.railOpen = String(open);
  syncRailAccessibility();
  if (open) {
    window.requestAnimationFrame(() => viewSearch.focus());
  } else if (restoreFocus && mobileRailQuery.matches) {
    window.requestAnimationFrame(() => railOpen.focus());
  }
}

railOpen.addEventListener("click", () => setRailOpen(true));
document
  .getElementById("railClose")
  .addEventListener("click", () => setRailOpen(false, { restoreFocus: true }));
document
  .getElementById("railScrim")
  .addEventListener("click", () => setRailOpen(false, { restoreFocus: true }));
mobileRailQuery.addEventListener("change", syncRailAccessibility);

document.addEventListener("keydown", (event) => {
  if (
    event.key !== "Tab" ||
    !mobileRailQuery.matches ||
    root.dataset.railOpen !== "true"
  ) {
    return;
  }
  const focusable = [...rail.querySelectorAll("button, input, a[href], [tabindex]")].filter(
    (element) => !element.disabled && element.getAttribute("tabindex") !== "-1",
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

resyncFrames.addEventListener("click", () => selectView(selectedPath));
window.setInterval(detectFrameDivergence, 500);
syncRailAccessibility();

async function loadRegistryStatus() {
  try {
    const response = await fetch("/api/views", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.views)) throw new Error("Malformed response");
    registryViews = payload.views.filter(
      (entry) => entry && typeof entry === "object" && safeRoutePath(entry.path),
    );

    const guiEntries = registryViews.filter((entry) => (entry.viewType ?? "gui") === "gui");
    const available = guiEntries.filter((entry) => entry.available !== false).length;
    registryStatus.textContent = `${guiEntries.length} GUI entries · ${available} available`;
    registryDot.dataset.state = "available";

    const requestedLiveView = requestedPath
      ? allViews().find((view) => view.path === requestedPath)
      : null;
    if (requestedLiveView && requestedPath !== selectedPath) {
      selectView(requestedPath);
      return;
    }

    const selectedView = allViews().find((view) => view.path === selectedPath);
    if (selectedView) updateSelectedView(selectedView);
    renderIndex(viewSearch.value);
  } catch {
    registryStatus.textContent = "Runtime registry unavailable; app routes still open";
    registryDot.dataset.state = "unavailable";
    renderIndex(viewSearch.value);
  }
}

comparison.dataset.layout = "split";
comparison.dataset.viewport = "desktop";
renderIndex();
selectView(selectedPath);
loadRegistryStatus();
