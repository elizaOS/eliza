/** Optional advice for loaded pages. This never grants a navigation or task exception. */
import { detectDomainLookalike } from "./domain-lookalike.mjs";

/** Runs only in the isolated main-frame realm. No account identity enters the page. */
export function renderProtectionAdvisory(state) {
  const key = "__elizaProtectionAdvisory";
  if (state && location.origin !== state.origin) return;
  const previous = globalThis[key];
  previous?.remove();
  if (!state) {
    delete globalThis[key];
    return;
  }
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; display: block !important; position: sticky !important; top: 0 !important; z-index: 2147483647 !important; width: 100% !important; }
    /* The person's Android font size (preferred-text-scale) applies to the advice even on a page that
       does not opt in to text scaling; a page that does already scales rem. */
    section { max-height: 45vh; overflow: auto; box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 20px; background: #fff2bd; color: #4a3428; border-bottom: 1px solid #9b7625; font: max(calc(20px * env(preferred-text-scale, 1)), 1.25rem)/1.4 system-ui,sans-serif; overflow-wrap: anywhere; }
    .words { flex: 1 1 280px; min-width: 0; }
    p { margin: 4px 0 0; }
    button { box-sizing: border-box; min-height: calc(48px * env(preferred-text-scale, 1)); max-width: 100%; padding: 8px 18px; border: 1px solid #796c62; border-radius: 24px; background: white; color: #322921; font: 600 max(calc(20px * env(preferred-text-scale, 1)), 1.25rem)/1.3 system-ui,sans-serif; cursor: pointer; overflow-wrap: anywhere; }
    button:focus-visible { outline: 3px solid #322921; outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .7; }
    @media (prefers-contrast: more) { section, button { border-width: 2px; } }
  `);
  root.adoptedStyleSheets = [sheet];
  const section = document.createElement("section");
  section.setAttribute("aria-label", state.copy.region);
  const words = document.createElement("div");
  words.className = "words";
  words.setAttribute("role", "status");
  const title = document.createElement("strong");
  title.textContent = state.marked ? state.copy.marked : state.title;
  const detail = document.createElement("p");
  detail.textContent = `${location.host} · ${state.marked ? state.copy.notScanned : state.detail}`;
  words.append(title, detail);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = state.marked ? state.copy.undo : state.copy.mark;
  button.disabled = !state.canMark;
  button.addEventListener("click", async (event) => {
    if (!event.isTrusted || button.disabled) return;
    button.disabled = true;
    try {
      const result = await globalThis.chrome.runtime.sendMessage({
        type: "protection-acknowledge",
        nonce: state.nonce,
        marked: !state.marked,
      });
      if (!result?.accepted) throw Error("Acknowledgement unavailable");
    } catch {
      // The website stays usable. A failed acknowledgement is never reported as saved.
      detail.textContent = state.copy.failed;
      button.disabled = !state.canMark;
    }
  });
  section.append(words, button);
  root.append(section);
  document.documentElement.prepend(host);
  globalThis[key] = { remove: () => host.remove(), shadow: root };
}

const defaultCopy = {
  region: "Website warning",
  unavailable: "This website wasn’t scanned",
  unavailableDetail: "Protection lists are unavailable or out of date.",
  lookalike: "This address may be pretending to be another website.",
  lookalikeDetail: "Similar spelling is a warning, not proof of fraud.",
  marked: "Marked as not suspicious",
  notScanned: "This does not mean the website was scanned.",
  mark: "Mark as not suspicious",
  undo: "Undo",
  failed: "That choice could not be saved. The website is still open.",
};

/** The owner comes only from trusted host composition, never a website message.
 * Changing or retiring it clears all in-memory acknowledgements before any await. */
export function createProtectionAdvisory(
  api,
  { referenceDomains = [], copy = {}, warningPage = "warning.html" } = {},
) {
  const labels = { ...defaultCopy, ...copy };
  if (
    Object.keys(copy).some((key) => !(key in defaultCopy)) ||
    Object.values(labels).some(
      (value) =>
        typeof value !== "string" || !value.trim() || value.length > 400,
    ) ||
    !Array.isArray(referenceDomains) ||
    referenceDomains.some((value) => typeof value !== "string")
  )
    throw Error("Invalid advisory policy");
  let owner = null;
  let epoch = 0;
  const acknowledgements = new Map();
  const displays = new Map();
  const tickets = new Map();
  const renders = new Map();
  async function show(tabId, address) {
    const ticket = (tickets.get(tabId) ?? 0) + 1;
    tickets.set(tabId, ticket);
    const revision = epoch;
    // A newer show for this tab replaces this one. An owner change alone does not: this page
    // still needs its advice, so it is drawn again for the new owner. Otherwise a page that
    // committed while the account context changed kept no advice until its next navigation.
    const replaced = () => tickets.get(tabId) !== ticket;
    const again = () => (replaced() ? undefined : show(tabId, address));
    displays.delete(tabId);
    let url;
    try {
      url = new URL(address);
    } catch {
      return;
    }
    if (address.startsWith(`${api.runtime.getURL(warningPage)}#`)) {
      try {
        acknowledgements.delete(
          new URL(address.slice(address.indexOf("#") + 1)).origin,
        );
      } catch {
        /* Invalid warning address has no acknowledgement. */
      }
    }
    if (!["http:", "https:"].includes(url.protocol)) return;
    let protection;
    try {
      ({ protection } = await api.storage.local.get("protection"));
    } catch {
      /* Missing is not a clean scan. */
    }
    // "current" means the threat rules are loaded. Their age does not matter.
    const current = protection?.status === "current";
    const similar = detectDomainLookalike(url.href, referenceDomains);
    const evidence = similar
      ? `lookalike:${similar.suggested}`
      : current
        ? "current"
        : "unavailable";
    if (replaced()) return;
    if (revision !== epoch) return again();
    if (
      acknowledgements.has(url.origin) &&
      acknowledgements.get(url.origin) !== evidence
    )
      acknowledgements.delete(url.origin);
    if (replaced()) return;
    if (revision !== epoch) return again();
    const nonce = crypto.randomUUID();
    const state =
      current && !similar
        ? null
        : {
            nonce,
            origin: url.origin,
            copy: labels,
            title: similar ? labels.lookalike : labels.unavailable,
            detail: similar ? labels.lookalikeDetail : labels.unavailableDetail,
            marked:
              owner !== null && acknowledgements.get(url.origin) === evidence,
            canMark: owner !== null,
          };
    // Bind the injection to the current URL before it starts. The page receipt is
    // checked again below; an origin change never inherits an acknowledgement.
    const tab = await api.tabs.get(tabId);
    if (tab.url !== address || replaced()) return;
    if (revision !== epoch) return again();
    const frame = await api.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame?.documentId || frame.url !== address) return;
    const work = (renders.get(tabId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (revision !== epoch || tickets.get(tabId) !== ticket) return [];
        return api.scripting.executeScript({
          target: { tabId, documentIds: [frame.documentId] },
          world: "ISOLATED",
          func: renderProtectionAdvisory,
          args: [state],
        });
      });
    renders.set(tabId, work);
    const results = await work;
    if (renders.get(tabId) === work) renders.delete(tabId);
    if (replaced()) return;
    if (revision !== epoch) return again();
    const result = results.find((value) => value.frameId === 0);
    if (typeof result?.documentId !== "string") return;
    if (!state) return true;
    displays.set(tabId, {
      nonce,
      origin: url.origin,
      evidence,
      documentId: result.documentId,
      revision,
    });
    return true;
  }
  const refreshTab = (tabId, address) =>
    void show(tabId, address).catch(() => {
      displays.delete(tabId);
    });
  async function refreshAll() {
    const tabs = await api.tabs.query({});
    const results = await Promise.all(
      tabs
        .filter(
          (tab) =>
            Number.isInteger(tab.id) && /^https?:\/\//.test(tab.url ?? ""),
        )
        .map((tab) =>
          show(tab.id, tab.url).catch(() => {
            displays.delete(tab.id);
          }),
        ),
    );
    return {
      updated: results.filter(Boolean).length,
      unavailable: results.filter((value) => !value).length,
    };
  }
  api.webNavigation.onCommitted.addListener((event) => {
    if (event.frameId === 0) refreshTab(event.tabId, event.url);
  });
  api.webNavigation.onHistoryStateUpdated.addListener((event) => {
    if (event.frameId === 0) refreshTab(event.tabId, event.url);
  });
  api.tabs.onRemoved.addListener((id) => {
    displays.delete(id);
    tickets.delete(id);
    renders.delete(id);
  });
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "protection-acknowledge") return;
    const shown = displays.get(sender.tab?.id);
    if (
      owner === null ||
      sender.id !== api.runtime.id ||
      sender.frameId !== 0 ||
      !shown ||
      shown.revision !== epoch ||
      sender.documentId !== shown.documentId ||
      message.nonce !== shown.nonce ||
      typeof message.marked !== "boolean"
    )
      return;
    let origin;
    try {
      origin = new URL(sender.url).origin;
    } catch {
      return;
    }
    if (origin !== shown.origin) return;
    if (message.marked) acknowledgements.set(origin, shown.evidence);
    else acknowledgements.delete(origin);
    void refreshAll().then(
      (result) => respond({ accepted: result.unavailable === 0 }),
      () => respond({ accepted: false }),
    );
    return true;
  });
  // Pages that committed before this worker registered its listeners (a cold browser start or a
  // worker restart) get their advice now, not only after the next list refresh or navigation.
  void refreshAll().catch(() => {});
  async function setOwner(value) {
    if (
      value !== null &&
      (typeof value !== "string" || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(value))
    )
      throw Error("Invalid advisory owner");
    if (value !== owner) {
      owner = value;
      epoch++;
      acknowledgements.clear();
      displays.clear();
    }
    return refreshAll();
  }
  return { refreshAll, setOwner };
}
