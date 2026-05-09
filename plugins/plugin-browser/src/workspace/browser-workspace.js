/**
 * Browser workspace — public API surface.
 *
 * Implementation is split across sibling modules:
 *   browser-workspace-types.ts      — all exported types and interfaces
 *   browser-workspace-state.ts      — global mutable state and CRUD helpers
 *   browser-workspace-helpers.ts    — small utilities, error factories, command normalization
 *   browser-workspace-jsdom.ts      — JSDOM loading, DOM creation, runtime setup
 *   browser-workspace-elements.ts   — element finding, selector parsing, inspection
 *   browser-workspace-network.ts    — network interception, HAR, tracked fetch
 *   browser-workspace-forms.ts      — form control interaction, activation, scrolling
 *   browser-workspace-snapshots.ts  — document snapshots, diff, PDF/screenshot
 *   browser-workspace-desktop.ts    — desktop bridge HTTP client and script generators
 *   browser-workspace-web.ts        — web-mode command execution
 *
 * This file re-exports every public symbol so external consumers are unaffected.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
// ── Re-export types ──────────────────────────────────────────────────
export { BROWSER_WORKSPACE_CONNECTOR_AUTH_STATES } from "./browser-workspace-types.js";
// ── Re-export state ──────────────────────────────────────────────────
export { __resetBrowserWorkspaceStateForTests } from "./browser-workspace-state.js";
// ── Re-export desktop bridge ─────────────────────────────────────────
import { evaluateBrowserWorkspaceTab as evaluateBrowserWorkspaceTabDesktop, executeDesktopBrowserWorkspaceDomCommand, executeDesktopBrowserWorkspaceUtilityCommand, getBrowserWorkspaceUnavailableMessage, getDesktopBrowserWorkspaceSessionState, getDesktopBrowserWorkspaceSnapshotRecord, isBrowserWorkspaceBridgeConfigured, loadDesktopBrowserWorkspaceSessionState, requestBrowserWorkspace, resolveBrowserWorkspaceBridgeConfig, resolveDesktopBrowserWorkspaceTargetTabId, snapshotBrowserWorkspaceTab as snapshotBrowserWorkspaceTabDesktop, } from "./browser-workspace-desktop.js";
// ── Re-export helpers ────────────────────────────────────────────────
import { assertBrowserWorkspaceConnectorSecretsNotExported, assertBrowserWorkspaceUrl, createBrowserWorkspaceNotFoundError, DEFAULT_WEB_PARTITION, inferBrowserWorkspaceTitle, normalizeBrowserWorkspaceCommand, resolveBrowserWorkspaceCommandPartition, resolveConnectorBrowserWorkspacePartition, sleep, } from "./browser-workspace-helpers.js";
export { getBrowserWorkspaceUnavailableMessage, isBrowserWorkspaceBridgeConfigured, resolveBrowserWorkspaceBridgeConfig, };
// ── Re-export forms ─────────────────────────────────────────────────
import { clearWebBrowserWorkspaceTabElementRefs, cloneWebBrowserWorkspaceTabState, loadWebBrowserWorkspaceTabDocument, pushWebBrowserWorkspaceHistory, } from "./browser-workspace-forms.js";
// ── Re-export network ────────────────────────────────────────────────
import { browserWorkspacePageFetch } from "./browser-workspace-helpers.js";
// ── Re-export jsdom ──────────────────────────────────────────────────
import { createEmptyWebBrowserWorkspaceDom, installBrowserWorkspaceWebRuntime, } from "./browser-workspace-jsdom.js";
// ── Re-export snapshots ──────────────────────────────────────────────
import { createBrowserWorkspacePdfBuffer, createBrowserWorkspaceSnapshotRecord, diffBrowserWorkspaceSnapshots, } from "./browser-workspace-snapshots.js";
// ── Imports for state ────────────────────────────────────────────────
import { clearBrowserWorkspaceElementRefs, clearBrowserWorkspaceRuntimeState, getBrowserWorkspaceRuntimeState, getBrowserWorkspaceTimestamp, resetBrowserWorkspaceRuntimeNavigationState, webWorkspaceState, withWebStateLock, } from "./browser-workspace-state.js";
// ── Re-export web ────────────────────────────────────────────────────
import { executeWebBrowserWorkspaceDomCommand, executeWebBrowserWorkspaceUtilityCommand, findWebBrowserWorkspaceTargetTabId, getWebBrowserWorkspaceTabIndex, getWebBrowserWorkspaceTabState, } from "./browser-workspace-web.js";
const AGENT_BROWSER_WORKSPACE_PARTITION = "persist:eliza-browser-agent";
const CONNECTOR_MANUAL_STATES = new Set([
    "auth_pending",
    "needs_reauth",
    "manual_handoff",
]);
// ────────────────────────────────────────────────────────────────────
// Public API functions
// ────────────────────────────────────────────────────────────────────
export function getBrowserWorkspaceMode(env = process.env) {
    return isBrowserWorkspaceBridgeConfigured(env) ? "desktop" : "web";
}
export function resolveBrowserWorkspaceConnectorPartition(provider, accountId) {
    return resolveConnectorBrowserWorkspacePartition(provider, accountId);
}
function normalizeConnectorAuthState(value, fallback) {
    switch (value) {
        case "unknown":
        case "ready":
        case "auth_pending":
        case "needs_reauth":
        case "manual_handoff":
            return value;
        default:
            return fallback;
    }
}
function connectorSessionRequiresManualHandoff(state) {
    return CONNECTOR_MANUAL_STATES.has(state);
}
function createConnectorSessionRef(ref) {
    return {
        kind: ref.kind,
        handleId: ref.handleId,
        partition: ref.partition,
        tabId: ref.tabId,
        browser: ref.browser,
        companionId: ref.companionId,
        profileId: ref.profileId,
        profileLabel: ref.profileLabel,
    };
}
function createConnectorSessionHandle(args) {
    const sessionRef = createConnectorSessionRef(args.ref);
    return {
        provider: args.provider,
        accountId: args.accountId,
        authState: args.authState,
        requiresManualHandoff: connectorSessionRequiresManualHandoff(args.authState),
        sessionRef,
        partition: sessionRef.partition,
        tabId: sessionRef.tabId,
        companionId: sessionRef.companionId,
        browser: sessionRef.browser,
        profileId: sessionRef.profileId,
        profileLabel: sessionRef.profileLabel,
        created: args.created,
        message: args.message ?? null,
    };
}
function createBrowserBridgeConnectorSessionHandle(args) {
    const browser = args.companion.browser?.trim() || null;
    const companionId = args.companion.companionId?.trim() || null;
    const profileId = args.companion.profileId?.trim() || null;
    const profileLabel = args.companion.profileLabel?.trim() || null;
    return createConnectorSessionHandle({
        provider: args.provider,
        accountId: args.accountId,
        authState: args.authState,
        created: false,
        message: args.message,
        ref: {
            kind: "browser-bridge-companion",
            handleId: [
                "browser-bridge",
                browser ?? "browser",
                companionId ?? profileId ?? "profile",
                args.provider,
                args.accountId,
            ].join(":"),
            partition: null,
            tabId: null,
            browser,
            companionId,
            profileId,
            profileLabel,
        },
    });
}
async function assertDesktopBrowserWorkspaceCanAccessProfileSecrets(command, env, operation) {
    const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
    const tabs = await listBrowserWorkspaceTabs(env);
    const tab = tabs.find((entry) => entry.id === id) ?? null;
    assertBrowserWorkspaceConnectorSecretsNotExported(tab?.partition, operation);
}
export async function acquireBrowserWorkspaceConnectorSession(request, env = process.env) {
    const provider = request.provider.trim();
    const accountId = request.accountId.trim();
    if (!provider) {
        throw new Error("Eliza browser connector session requires provider.");
    }
    if (!accountId) {
        throw new Error("Eliza browser connector session requires accountId.");
    }
    const companion = request.companion ?? null;
    if (companion?.profileId || companion?.companionId) {
        const authState = normalizeConnectorAuthState(request.authState, "manual_handoff");
        return createBrowserBridgeConnectorSessionHandle({
            provider,
            accountId,
            companion,
            authState,
            message: request.manualHandoffReason ??
                "Use the paired browser companion profile to finish login, MFA, or CAPTCHA if required.",
        });
    }
    if (isBrowserWorkspaceBridgeConfigured(env)) {
        const payload = await requestBrowserWorkspace("/sessions/acquire", {
            method: "POST",
            body: JSON.stringify({
                accountId,
                authState: request.authState,
                manualHandoffReason: request.manualHandoffReason,
                provider,
                reuse: request.reuse,
                show: request.show,
                title: request.title,
                url: request.url,
            }),
        }, env);
        return payload.session;
    }
    const partition = resolveBrowserWorkspaceConnectorPartition(provider, accountId);
    const reuse = request.reuse !== false;
    const tabs = reuse ? await listBrowserWorkspaceTabs(env) : [];
    const existing = tabs.find((tab) => tab.partition === partition) ?? null;
    let tab = existing;
    let created = false;
    if (!tab) {
        tab = await openBrowserWorkspaceTab({
            kind: "internal",
            partition,
            show: request.show ?? true,
            title: request.title,
            url: request.url,
        }, env);
        created = true;
    }
    else if (request.show === true) {
        tab = await showBrowserWorkspaceTab(tab.id, env);
    }
    const authState = normalizeConnectorAuthState(request.authState, created ? "auth_pending" : "ready");
    return createConnectorSessionHandle({
        provider,
        accountId,
        authState,
        created,
        message: request.manualHandoffReason ??
            (connectorSessionRequiresManualHandoff(authState)
                ? "Manual login, MFA, or CAPTCHA may be required in this isolated connector browser session."
                : null),
        ref: {
            kind: "internal-browser",
            handleId: `internal-browser:${partition}`,
            partition,
            tabId: tab.id,
            browser: null,
            companionId: null,
            profileId: null,
            profileLabel: null,
        },
    });
}
export async function getBrowserWorkspaceSnapshot(env = process.env) {
    return {
        mode: getBrowserWorkspaceMode(env),
        tabs: await listBrowserWorkspaceTabs(env),
    };
}
export async function listBrowserWorkspaceTabs(env = process.env) {
    if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return webWorkspaceState.tabs.map((tab) => ({
            id: tab.id,
            title: tab.title,
            url: tab.url,
            partition: tab.partition,
            kind: tab.kind,
            visible: tab.visible,
            createdAt: tab.createdAt,
            updatedAt: tab.updatedAt,
            lastFocusedAt: tab.lastFocusedAt,
        }));
    }
    const payload = await requestBrowserWorkspace("/tabs", undefined, env);
    return Array.isArray(payload.tabs) ? payload.tabs : [];
}
export async function openBrowserWorkspaceTab(request, env = process.env) {
    if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return withWebStateLock(() => {
            const kind = request.kind === "internal" ? "internal" : "standard";
            const now = getBrowserWorkspaceTimestamp();
            const url = assertBrowserWorkspaceUrl(request.url?.trim() || "about:blank");
            const visible = request.show === true;
            const id = `btab_${webWorkspaceState.nextId++}`;
            const dom = url === "about:blank" ? createEmptyWebBrowserWorkspaceDom(url) : null;
            const tab = {
                id,
                title: request.title?.trim() || inferBrowserWorkspaceTitle(url),
                url,
                partition: request.partition?.trim() || DEFAULT_WEB_PARTITION,
                kind,
                visible,
                createdAt: now,
                updatedAt: now,
                lastFocusedAt: visible ? now : null,
                dom,
                history: [url],
                historyIndex: 0,
                loadedUrl: url === "about:blank" ? url : null,
            };
            if (dom) {
                installBrowserWorkspaceWebRuntime(tab, dom);
            }
            getBrowserWorkspaceRuntimeState("web", tab.id);
            clearWebBrowserWorkspaceTabElementRefs(tab.id);
            if (tab.visible) {
                webWorkspaceState.tabs = webWorkspaceState.tabs.map((entry) => ({
                    ...entry,
                    visible: false,
                }));
            }
            webWorkspaceState.tabs = [...webWorkspaceState.tabs, tab];
            return cloneWebBrowserWorkspaceTabState(tab);
        });
    }
    const payload = await requestBrowserWorkspace("/tabs", {
        method: "POST",
        body: JSON.stringify(request),
    }, env);
    return payload.tab;
}
export async function navigateBrowserWorkspaceTab(request, env = process.env) {
    const nextUrl = assertBrowserWorkspaceUrl(request.url);
    if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return withWebStateLock(() => {
            const index = getWebBrowserWorkspaceTabIndex(request.id);
            if (index < 0) {
                throw createBrowserWorkspaceNotFoundError(request.id);
            }
            const existing = webWorkspaceState.tabs[index];
            const updatedAt = getBrowserWorkspaceTimestamp();
            const state = getBrowserWorkspaceRuntimeState("web", existing.id);
            clearWebBrowserWorkspaceTabElementRefs(existing.id);
            pushWebBrowserWorkspaceHistory(existing, nextUrl);
            const nextDom = nextUrl === "about:blank"
                ? createEmptyWebBrowserWorkspaceDom(nextUrl)
                : null;
            const nextTab = {
                ...existing,
                title: inferBrowserWorkspaceTitle(nextUrl),
                url: nextUrl,
                updatedAt,
                dom: nextDom,
                loadedUrl: nextUrl === "about:blank" ? nextUrl : null,
            };
            if (nextDom) {
                installBrowserWorkspaceWebRuntime(nextTab, nextDom);
            }
            resetBrowserWorkspaceRuntimeNavigationState(state);
            webWorkspaceState.tabs[index] = nextTab;
            return cloneWebBrowserWorkspaceTabState(nextTab);
        });
    }
    const payload = await requestBrowserWorkspace(`/tabs/${encodeURIComponent(request.id)}/navigate`, {
        method: "POST",
        body: JSON.stringify({ url: nextUrl }),
    }, env);
    return payload.tab;
}
export async function showBrowserWorkspaceTab(id, env = process.env) {
    if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return withWebStateLock(() => {
            getWebBrowserWorkspaceTabState(id);
            const lastFocusedAt = getBrowserWorkspaceTimestamp();
            webWorkspaceState.tabs = webWorkspaceState.tabs.map((tab) => ({
                ...tab,
                visible: tab.id === id,
                lastFocusedAt: tab.id === id ? lastFocusedAt : tab.lastFocusedAt,
                updatedAt: tab.id === id ? lastFocusedAt : tab.updatedAt,
            }));
            return cloneWebBrowserWorkspaceTabState(getWebBrowserWorkspaceTabState(id));
        });
    }
    const payload = await requestBrowserWorkspace(`/tabs/${encodeURIComponent(id)}/show`, { method: "POST" }, env);
    return payload.tab;
}
export async function hideBrowserWorkspaceTab(id, env = process.env) {
    if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return withWebStateLock(() => {
            const index = getWebBrowserWorkspaceTabIndex(id);
            if (index < 0) {
                throw createBrowserWorkspaceNotFoundError(id);
            }
            const updatedAt = getBrowserWorkspaceTimestamp();
            const nextTab = {
                ...webWorkspaceState.tabs[index],
                visible: false,
                updatedAt,
            };
            webWorkspaceState.tabs[index] = nextTab;
            return cloneWebBrowserWorkspaceTabState(nextTab);
        });
    }
    const payload = await requestBrowserWorkspace(`/tabs/${encodeURIComponent(id)}/hide`, { method: "POST" }, env);
    return payload.tab;
}
export async function closeBrowserWorkspaceTab(id, env = process.env) {
    if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return withWebStateLock(() => {
            const initialLength = webWorkspaceState.tabs.length;
            clearWebBrowserWorkspaceTabElementRefs(id);
            clearBrowserWorkspaceRuntimeState("web", id);
            webWorkspaceState.tabs = webWorkspaceState.tabs.filter((tab) => tab.id !== id);
            return webWorkspaceState.tabs.length !== initialLength;
        });
    }
    const payload = await requestBrowserWorkspace(`/tabs/${encodeURIComponent(id)}`, { method: "DELETE" }, env);
    return payload.closed === true;
}
export async function evaluateBrowserWorkspaceTab(request, env = process.env) {
    return evaluateBrowserWorkspaceTabDesktop(request, env);
}
export async function snapshotBrowserWorkspaceTab(id, env = process.env) {
    return snapshotBrowserWorkspaceTabDesktop(id, env);
}
// ────────────────────────────────────────────────────────────────────
// Main command router
// ────────────────────────────────────────────────────────────────────
export async function executeBrowserWorkspaceCommand(command, env = process.env) {
    command = normalizeBrowserWorkspaceCommand(command);
    switch (command.subaction) {
        case "batch": {
            const steps = Array.isArray(command.steps) ? command.steps : [];
            if (steps.length === 0) {
                throw new Error("Eliza browser workspace batch requires at least one step.");
            }
            const results = [];
            for (const step of steps) {
                results.push(await executeBrowserWorkspaceCommand(step, env));
            }
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                steps: results,
                value: results.at(-1)?.value,
            };
        }
        case "list":
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                tabs: await listBrowserWorkspaceTabs(env),
            };
        case "open": {
            const tab = await openBrowserWorkspaceTab({
                partition: resolveBrowserWorkspaceCommandPartition(command, AGENT_BROWSER_WORKSPACE_PARTITION),
                show: command.show,
                title: command.title,
                url: command.url,
            }, env);
            clearBrowserWorkspaceElementRefs(getBrowserWorkspaceMode(env), tab.id);
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                tab,
            };
        }
        case "navigate": {
            const id = isBrowserWorkspaceBridgeConfigured(env)
                ? await resolveDesktopBrowserWorkspaceTargetTabId(command, env)
                : findWebBrowserWorkspaceTargetTabId(command);
            clearBrowserWorkspaceElementRefs(getBrowserWorkspaceMode(env), id);
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                tab: await navigateBrowserWorkspaceTab({
                    id,
                    url: command.url ?? "",
                }, env),
            };
        }
        case "show": {
            const id = isBrowserWorkspaceBridgeConfigured(env)
                ? await resolveDesktopBrowserWorkspaceTargetTabId(command, env)
                : findWebBrowserWorkspaceTargetTabId(command);
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                tab: await showBrowserWorkspaceTab(id, env),
            };
        }
        case "hide": {
            const id = isBrowserWorkspaceBridgeConfigured(env)
                ? await resolveDesktopBrowserWorkspaceTargetTabId(command, env)
                : findWebBrowserWorkspaceTargetTabId(command);
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                tab: await hideBrowserWorkspaceTab(id, env),
            };
        }
        case "close": {
            const id = isBrowserWorkspaceBridgeConfigured(env)
                ? await resolveDesktopBrowserWorkspaceTargetTabId(command, env)
                : findWebBrowserWorkspaceTargetTabId(command);
            clearBrowserWorkspaceElementRefs(getBrowserWorkspaceMode(env), id);
            clearBrowserWorkspaceRuntimeState(getBrowserWorkspaceMode(env), id);
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                closed: await closeBrowserWorkspaceTab(id, env),
            };
        }
        case "eval": {
            if (!isBrowserWorkspaceBridgeConfigured(env)) {
                return (await executeWebBrowserWorkspaceUtilityCommand(command));
            }
            const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
            return {
                mode: "desktop",
                subaction: command.subaction,
                value: await evaluateBrowserWorkspaceTab({
                    id,
                    script: command.script ?? "",
                }, env),
            };
        }
        case "screenshot": {
            if (!isBrowserWorkspaceBridgeConfigured(env)) {
                return (await executeWebBrowserWorkspaceUtilityCommand(command));
            }
            const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
            return {
                mode: "desktop",
                subaction: command.subaction,
                snapshot: await snapshotBrowserWorkspaceTab(id, env),
            };
        }
        case "clipboard":
        case "console":
        case "cookies":
        case "dialog":
        case "drag":
        case "errors":
        case "frame":
        case "highlight":
        case "mouse":
        case "network":
        case "set":
        case "storage":
        case "upload": {
            if (!isBrowserWorkspaceBridgeConfigured(env)) {
                return (await executeWebBrowserWorkspaceUtilityCommand(command));
            }
            return executeDesktopBrowserWorkspaceUtilityCommand(command, env);
        }
        case "diff": {
            if (!isBrowserWorkspaceBridgeConfigured(env)) {
                return (await executeWebBrowserWorkspaceUtilityCommand(command));
            }
            const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
            const runtime = getBrowserWorkspaceRuntimeState("desktop", id);
            const snapshot = await getDesktopBrowserWorkspaceSnapshotRecord(command, env);
            if (command.diffAction === "screenshot") {
                const screenshot = await snapshotBrowserWorkspaceTab(id, env);
                const currentData = screenshot.data;
                const baseline = command.baselinePath?.trim()
                    ? await fsp.readFile(path.resolve(command.baselinePath.trim()), "base64")
                    : runtime.lastScreenshotData;
                runtime.lastScreenshotData = currentData;
                return {
                    mode: "desktop",
                    subaction: command.subaction,
                    value: {
                        baselineLength: baseline?.length ?? 0,
                        changed: baseline !== currentData,
                        currentLength: currentData.length,
                    },
                };
            }
            if (command.diffAction === "url") {
                const leftUrl = command.url?.trim() || snapshot.url;
                const rightUrl = command.secondaryUrl?.trim();
                if (!rightUrl) {
                    throw new Error("Eliza browser workspace diff url requires secondaryUrl.");
                }
                const left = await browserWorkspacePageFetch(leftUrl);
                const right = await browserWorkspacePageFetch(rightUrl);
                return {
                    mode: "desktop",
                    subaction: command.subaction,
                    value: diffBrowserWorkspaceSnapshots(createBrowserWorkspaceSnapshotRecord(leftUrl, left.url || leftUrl, await left.text()), createBrowserWorkspaceSnapshotRecord(rightUrl, right.url || rightUrl, await right.text())),
                };
            }
            const baseline = command.baselinePath?.trim()
                ? JSON.parse(await fsp.readFile(path.resolve(command.baselinePath.trim()), "utf8"))
                : runtime.lastSnapshot;
            const diff = diffBrowserWorkspaceSnapshots(baseline, snapshot);
            runtime.lastSnapshot = snapshot;
            return { mode: "desktop", subaction: command.subaction, value: diff };
        }
        case "trace":
        case "profiler": {
            if (!isBrowserWorkspaceBridgeConfigured(env)) {
                return (await executeWebBrowserWorkspaceUtilityCommand(command));
            }
            const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
            const runtime = getBrowserWorkspaceRuntimeState("desktop", id);
            const target = command.subaction === "trace" ? runtime.trace : runtime.profiler;
            const stop = command.subaction === "trace"
                ? command.traceAction === "stop"
                : command.profilerAction === "stop";
            if (stop) {
                target.active = false;
                const payload = { entries: target.entries };
                const filePath = command.filePath?.trim() || command.outputPath?.trim();
                if (filePath) {
                    const { writeBrowserWorkspaceFile } = await import("./browser-workspace-helpers.js");
                    await writeBrowserWorkspaceFile(filePath, JSON.stringify(payload, null, 2));
                    return {
                        mode: "desktop",
                        subaction: command.subaction,
                        value: { path: path.resolve(filePath), ...payload },
                    };
                }
                return {
                    mode: "desktop",
                    subaction: command.subaction,
                    value: payload,
                };
            }
            target.active = true;
            target.entries = [
                {
                    command: `${command.subaction}:start`,
                    timestamp: getBrowserWorkspaceTimestamp(),
                },
            ];
            return {
                mode: "desktop",
                subaction: command.subaction,
                value: { active: true },
            };
        }
        case "state": {
            if (!isBrowserWorkspaceBridgeConfigured(env)) {
                return (await executeWebBrowserWorkspaceUtilityCommand(command));
            }
            await assertDesktopBrowserWorkspaceCanAccessProfileSecrets(command, env, "state");
            if (command.stateAction === "load") {
                const filePath = command.filePath?.trim() || command.outputPath?.trim();
                if (!filePath) {
                    throw new Error("Eliza browser workspace state load requires filePath.");
                }
                const payload = JSON.parse(await fsp.readFile(path.resolve(filePath), "utf8"));
                await loadDesktopBrowserWorkspaceSessionState(command, payload, env);
                return {
                    mode: "desktop",
                    subaction: command.subaction,
                    value: { loaded: true },
                };
            }
            const payload = await getDesktopBrowserWorkspaceSessionState(command, env);
            const filePath = command.filePath?.trim() || command.outputPath?.trim();
            if (filePath) {
                const { writeBrowserWorkspaceFile } = await import("./browser-workspace-helpers.js");
                await writeBrowserWorkspaceFile(filePath, JSON.stringify(payload, null, 2));
                return {
                    mode: "desktop",
                    subaction: command.subaction,
                    value: { path: path.resolve(filePath), ...payload },
                };
            }
            return { mode: "desktop", subaction: command.subaction, value: payload };
        }
        case "pdf": {
            if (!isBrowserWorkspaceBridgeConfigured(env)) {
                return (await executeWebBrowserWorkspaceUtilityCommand(command));
            }
            const filePath = command.filePath?.trim() || command.outputPath?.trim();
            if (!filePath) {
                throw new Error("Eliza browser workspace pdf requires filePath.");
            }
            const snapshot = await getDesktopBrowserWorkspaceSnapshotRecord(command, env);
            const pdf = createBrowserWorkspacePdfBuffer(snapshot.title, snapshot.bodyText);
            const { writeBrowserWorkspaceFile } = await import("./browser-workspace-helpers.js");
            const resolved = await writeBrowserWorkspaceFile(filePath, pdf);
            return {
                mode: "desktop",
                subaction: command.subaction,
                value: { path: resolved, size: pdf.byteLength },
            };
        }
        case "tab": {
            const action = command.tabAction ?? "list";
            if (action === "list") {
                return {
                    mode: getBrowserWorkspaceMode(env),
                    subaction: command.subaction,
                    tabs: await listBrowserWorkspaceTabs(env),
                };
            }
            if (action === "new") {
                return {
                    mode: getBrowserWorkspaceMode(env),
                    subaction: command.subaction,
                    tab: await openBrowserWorkspaceTab({
                        partition: resolveBrowserWorkspaceCommandPartition(command, AGENT_BROWSER_WORKSPACE_PARTITION),
                        show: command.show ?? true,
                        title: command.title,
                        url: command.url,
                        width: command.width,
                        height: command.height,
                    }, env),
                };
            }
            if (action === "switch") {
                const tabs = await listBrowserWorkspaceTabs(env);
                const target = command.id?.trim()
                    ? tabs.find((tab) => tab.id === command.id?.trim())
                    : typeof command.index === "number"
                        ? (tabs[command.index] ?? null)
                        : null;
                if (!target) {
                    throw new Error("Eliza browser workspace tab switch requires a valid id or index.");
                }
                return {
                    mode: getBrowserWorkspaceMode(env),
                    subaction: command.subaction,
                    tab: await showBrowserWorkspaceTab(target.id, env),
                };
            }
            const targetId = command.id?.trim() ||
                (await listBrowserWorkspaceTabs(env))[command.index ?? -1]?.id;
            if (!targetId) {
                throw new Error("Eliza browser workspace tab close requires a valid id or index.");
            }
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                closed: await closeBrowserWorkspaceTab(targetId, env),
            };
        }
        case "window":
            return {
                mode: getBrowserWorkspaceMode(env),
                subaction: command.subaction,
                tab: await openBrowserWorkspaceTab({
                    partition: resolveBrowserWorkspaceCommandPartition(command, AGENT_BROWSER_WORKSPACE_PARTITION),
                    show: true,
                    title: command.title,
                    url: command.url,
                    width: command.width,
                    height: command.height,
                }, env),
            };
        case "back":
        case "forward":
        case "reload": {
            if (isBrowserWorkspaceBridgeConfigured(env)) {
                const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
                clearBrowserWorkspaceElementRefs("desktop", id);
                return executeDesktopBrowserWorkspaceDomCommand(command, env);
            }
            return withWebStateLock(async () => {
                const id = findWebBrowserWorkspaceTargetTabId(command);
                const tab = getWebBrowserWorkspaceTabState(id);
                if (command.subaction === "reload") {
                    clearWebBrowserWorkspaceTabElementRefs(tab.id);
                    tab.dom = null;
                    tab.loadedUrl = null;
                    await loadWebBrowserWorkspaceTabDocument(tab);
                    return {
                        mode: "web",
                        subaction: command.subaction,
                        tab: cloneWebBrowserWorkspaceTabState(tab),
                        value: { url: tab.url, title: tab.title },
                    };
                }
                const delta = command.subaction === "back" ? -1 : 1;
                const nextIndex = tab.historyIndex + delta;
                if (nextIndex < 0 || nextIndex >= tab.history.length) {
                    return {
                        mode: "web",
                        subaction: command.subaction,
                        tab: cloneWebBrowserWorkspaceTabState(tab),
                        value: { url: tab.url, title: tab.title, changed: false },
                    };
                }
                tab.historyIndex = nextIndex;
                tab.url = tab.history[nextIndex] ?? tab.url;
                tab.title = inferBrowserWorkspaceTitle(tab.url);
                clearWebBrowserWorkspaceTabElementRefs(tab.id);
                tab.dom = null;
                tab.loadedUrl = null;
                await loadWebBrowserWorkspaceTabDocument(tab);
                return {
                    mode: "web",
                    subaction: command.subaction,
                    tab: cloneWebBrowserWorkspaceTabState(tab),
                    value: { url: tab.url, title: tab.title, changed: true },
                };
            });
        }
        case "inspect":
        case "snapshot":
        case "check":
        case "click":
        case "dblclick":
        case "find":
        case "fill":
        case "focus":
        case "get":
        case "hover":
        case "keydown":
        case "keyup":
        case "keyboardinserttext":
        case "keyboardtype":
        case "press":
        case "scroll":
        case "scrollinto":
        case "select":
        case "type":
        case "uncheck":
        case "wait":
        case "realistic-click":
        case "realistic-fill":
        case "realistic-type":
        case "realistic-press":
        case "realistic-upload":
        case "cursor-move":
        case "cursor-hide":
            if (command.subaction === "wait" &&
                !command.selector &&
                !command.findBy &&
                !command.text &&
                !command.url &&
                !command.script &&
                typeof command.timeoutMs === "number" &&
                Number.isFinite(command.timeoutMs)) {
                const waitedMs = Math.max(0, command.timeoutMs);
                await sleep(waitedMs);
                return {
                    mode: getBrowserWorkspaceMode(env),
                    subaction: command.subaction,
                    value: { waitedMs },
                };
            }
            if (isBrowserWorkspaceBridgeConfigured(env)) {
                return executeDesktopBrowserWorkspaceDomCommand(command, env);
            }
            return executeWebBrowserWorkspaceDomCommand(command);
        default: {
            const exhaustive = command.subaction;
            throw new Error(`Unsupported browser workspace subaction: ${exhaustive}`);
        }
    }
}
