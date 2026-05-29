/**
 * @module plugin-app-control/services/app-registry-service
 *
 * Atomically persists app definitions registered via the
 * `load_from_directory` sub-mode of the unified APP action so they survive
 * runtime restarts. On boot, re-applies the persisted entries via
 * `registerCuratedApp(...)`. Idempotent.
 *
 * Also owns:
 * - the app-loads audit log at `~/.<namespace>/audit/app-loads.jsonl`
 * - the granted-permissions store at `~/.<namespace>/granted-permissions.json`
 * - the app-permissions audit log at `~/.<namespace>/audit/app-permissions.jsonl`
 *
 * See:
 * - `eliza/packages/docs/architecture/app-permissions-manifest.md` (slice 1)
 * - `eliza/packages/docs/architecture/app-permissions-granted-store.md` (slice 2)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger, resolveStateDir, Service, } from "@elizaos/core";
import { RECOGNISED_PERMISSION_NAMESPACES, recognisedNamespacesForRaw, registerCuratedApp, } from "@elizaos/shared";
export const APP_REGISTRY_SERVICE_TYPE = "app-registry";
function registryFilePath(stateDir) {
    return path.join(stateDir, "app-registry.json");
}
function grantsFilePath(stateDir) {
    return path.join(stateDir, "granted-permissions.json");
}
function auditFilePath(stateDir) {
    return path.join(stateDir, "audit", "app-loads.jsonl");
}
function permissionsAuditFilePath(stateDir) {
    return path.join(stateDir, "audit", "app-permissions.jsonl");
}
async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}
async function readPersisted(file) {
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (raw === null) {
        return { version: 1, entries: [] };
    }
    const parsed = JSON.parse(raw);
    if (!parsed ||
        typeof parsed !== "object" ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.entries)) {
        logger.warn(`[plugin-app-control] app-registry.json malformed; resetting (file=${file})`);
        return { version: 1, entries: [] };
    }
    const entries = [];
    for (const e of parsed.entries) {
        if (typeof e !== "object" || e === null)
            continue;
        const candidate = e;
        if (typeof candidate.slug !== "string" ||
            typeof candidate.canonicalName !== "string" ||
            typeof candidate.directory !== "string" ||
            typeof candidate.displayName !== "string" ||
            !Array.isArray(candidate.aliases)) {
            continue;
        }
        if (candidate.requestedPermissions !== undefined) {
            if (typeof candidate.requestedPermissions !== "object" ||
                candidate.requestedPermissions === null ||
                Array.isArray(candidate.requestedPermissions)) {
                continue;
            }
        }
        // Default `trust` for back-compat with entries written before the
        // trust field was persisted. Directory-loaded entries are by
        // construction external; first-party entries (when added) get an
        // explicit `trust: "first-party"` at register time.
        const trust = candidate.trust === "first-party" ? "first-party" : "external";
        // Default `isolation` for back-compat with pre-Phase-2 entries, then
        // apply the same Phase 3 policy used by register(): persisted external
        // apps cannot retain or regain the in-process fast path after restart.
        const declaredIsolation = candidate.isolation === "worker" ? "worker" : "none";
        const isolation = trust === "external" ? "worker" : declaredIsolation;
        entries.push({ ...candidate, trust, isolation });
    }
    return { version: 1, entries };
}
async function writePersistedAtomic(file, payload) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    await ensureDir(path.dirname(file));
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, file);
}
async function appendAuditLine(file, line) {
    await ensureDir(path.dirname(file));
    await fs.appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}
async function readGrants(file) {
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (raw === null)
        return { version: 1, grants: {} };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        logger.warn(`[plugin-app-control] granted-permissions.json malformed JSON; resetting (file=${file})`);
        return { version: 1, grants: {} };
    }
    if (!parsed ||
        typeof parsed !== "object" ||
        parsed.version !== 1 ||
        typeof parsed.grants !== "object" ||
        parsed.grants === null) {
        logger.warn(`[plugin-app-control] granted-permissions.json malformed shape; resetting (file=${file})`);
        return { version: 1, grants: {} };
    }
    const rawGrants = parsed.grants;
    const grants = {};
    for (const [slug, value] of Object.entries(rawGrants)) {
        if (!value ||
            typeof value !== "object" ||
            !Array.isArray(value.namespaces) ||
            typeof value.grantedAt !== "string" ||
            typeof value.lastUpdatedAt !== "string") {
            continue;
        }
        const namespaces = value.namespaces.filter((n) => typeof n === "string" &&
            RECOGNISED_PERMISSION_NAMESPACES.includes(n));
        grants[slug] = {
            namespaces,
            grantedAt: value.grantedAt,
            lastUpdatedAt: value.lastUpdatedAt,
        };
    }
    return { version: 1, grants };
}
async function writeGrantsAtomic(file, payload) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    await ensureDir(path.dirname(file));
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, file);
}
export class AppRegistryService extends Service {
    static serviceType = APP_REGISTRY_SERVICE_TYPE;
    capabilityDescription = "Persists app definitions registered via load_from_directory and re-registers them at boot. Owns the app-loads audit log.";
    stateDir;
    registryPath;
    auditPath;
    grantsPath;
    permissionsAuditPath;
    constructor(runtime) {
        super(runtime);
        this.stateDir = resolveStateDir();
        this.registryPath = registryFilePath(this.stateDir);
        this.auditPath = auditFilePath(this.stateDir);
        this.grantsPath = grantsFilePath(this.stateDir);
        this.permissionsAuditPath = permissionsAuditFilePath(this.stateDir);
    }
    static async start(runtime) {
        const service = new AppRegistryService(runtime);
        await service.bootstrap();
        return service;
    }
    async stop() {
        // no-op — persistence is sync per write.
    }
    async bootstrap() {
        const persisted = await readPersisted(this.registryPath);
        for (const entry of persisted.entries) {
            registerCuratedApp(entry);
        }
        if (persisted.entries.length > 0) {
            logger.info(`[plugin-app-control] AppRegistryService re-registered ${persisted.entries.length} app(s) from ${this.registryPath}`);
        }
    }
    async list() {
        const persisted = await readPersisted(this.registryPath);
        return persisted.entries;
    }
    async register(entry, ctx = {}) {
        const trust = ctx.trust ?? entry.trust ?? "external";
        // Phase 3 policy: apps loaded as `trust: "external"` default to
        // `isolation: "worker"` even if they did not declare it. Apps
        // can request *more* isolation (declaring "worker" while
        // trust:"first-party") but never *less* — an external app that
        // declared "none" still gets promoted to "worker" here. This is
        // the load-bearing default-tightening for the sandbox story:
        // once Phase 1 + 2 plumbing is in place, external apps simply
        // can't reach the in-process fast path without an explicit
        // first-party trust override.
        const declaredIsolation = entry.isolation ?? "none";
        const isolation = trust === "external" ? "worker" : declaredIsolation;
        const persistedEntry = { ...entry, trust, isolation };
        registerCuratedApp(persistedEntry);
        const persisted = await readPersisted(this.registryPath);
        const idx = persisted.entries.findIndex((e) => e.slug === persistedEntry.slug);
        if (idx >= 0) {
            persisted.entries[idx] = persistedEntry;
        }
        else {
            persisted.entries.push(persistedEntry);
        }
        await writePersistedAtomic(this.registryPath, persisted);
        await appendAuditLine(this.auditPath, {
            kind: "registered",
            timestamp: new Date().toISOString(),
            directory: persistedEntry.directory,
            appName: persistedEntry.canonicalName,
            slug: persistedEntry.slug,
            displayName: persistedEntry.displayName,
            trust,
            isolation,
            requestedPermissions: persistedEntry.requestedPermissions ?? null,
            registeredByEntity: ctx.requesterEntityId ?? null,
            registeredByRoom: ctx.requesterRoomId ?? null,
        });
        if (trust === "first-party") {
            const declared = recognisedNamespacesForRaw(persistedEntry.requestedPermissions);
            if (declared.length > 0) {
                await this.writeGrant(persistedEntry.slug, declared, "first-party-auto");
            }
        }
        // Phase 2.5: if the app declared isolation:"worker", auto-spawn
        // the sandbox worker via AppWorkerHostService. The host service
        // is looked up by string type to avoid an import cycle between
        // the registry and the host service modules. Spawn failures are
        // logged but do not fail the register call — the entry still
        // persists so the operator can inspect / re-spawn later.
        if (isolation === "worker") {
            await this.startWorkerBestEffort(persistedEntry.slug);
        }
    }
    async recordManifestRejection(rejection) {
        await appendAuditLine(this.auditPath, {
            kind: "rejected-manifest",
            timestamp: new Date().toISOString(),
            directory: rejection.directory,
            appName: rejection.packageName,
            reason: rejection.reason,
            path: rejection.path,
            registeredByEntity: rejection.requesterEntityId ?? null,
            registeredByRoom: rejection.requesterRoomId ?? null,
        });
    }
    async getGrantedNamespaces(slug) {
        const grants = await readGrants(this.grantsPath);
        return grants.grants[slug]?.namespaces ?? [];
    }
    async setGrantedNamespaces(slug, namespaces, actor) {
        const persisted = await readPersisted(this.registryPath);
        const entry = persisted.entries.find((e) => e.slug === slug);
        if (!entry) {
            return {
                ok: false,
                reason: `No app registered under slug=${slug}`,
            };
        }
        const requested = recognisedNamespacesForRaw(entry.requestedPermissions);
        const requestedSet = new Set(requested);
        const recognisedSet = new Set(RECOGNISED_PERMISSION_NAMESPACES);
        const unknown = [];
        const notRequested = [];
        const valid = [];
        for (const raw of namespaces) {
            if (!recognisedSet.has(raw)) {
                unknown.push(raw);
                continue;
            }
            const ns = raw;
            if (!requestedSet.has(ns)) {
                notRequested.push(ns);
                continue;
            }
            if (!valid.includes(ns))
                valid.push(ns);
        }
        if (unknown.length > 0) {
            return {
                ok: false,
                reason: `Unknown namespace(s): ${unknown.join(", ")}`,
                unknownNamespaces: unknown,
            };
        }
        if (notRequested.length > 0) {
            return {
                ok: false,
                reason: `Namespace(s) not declared by the app's manifest: ${notRequested.join(", ")}`,
                notRequestedNamespaces: notRequested,
            };
        }
        const updatedGrants = await this.writeGrant(slug, valid, actor);
        // Build the view directly from the entry we already have and the
        // grants snapshot we just wrote. Avoids re-reading both files
        // (which would also widen the race window if a concurrent PUT
        // landed between this write and the re-read).
        const view = buildViewFromGrants(entry, updatedGrants);
        await this.refreshWorkerGrantsBestEffort(entry, view.grantedNamespaces);
        return {
            ok: true,
            view,
        };
    }
    async getPermissionsView(slug) {
        const [persisted, grants] = await Promise.all([
            readPersisted(this.registryPath),
            readGrants(this.grantsPath),
        ]);
        const entry = persisted.entries.find((e) => e.slug === slug);
        if (!entry)
            return null;
        return buildViewFromGrants(entry, grants);
    }
    async listPermissionsViews() {
        const [persisted, grants] = await Promise.all([
            readPersisted(this.registryPath),
            readGrants(this.grantsPath),
        ]);
        return persisted.entries.map((entry) => buildViewFromGrants(entry, grants));
    }
    async writeGrant(slug, namespaces, actor) {
        const grants = await readGrants(this.grantsPath);
        const now = new Date().toISOString();
        const previous = grants.grants[slug];
        const sortedNamespaces = [...new Set(namespaces)].sort();
        const previousSorted = previous
            ? [...previous.namespaces].sort()
            : [];
        const namespacesUnchanged = sortedNamespaces.length === previousSorted.length &&
            sortedNamespaces.every((ns, i) => ns === previousSorted[i]);
        if (sortedNamespaces.length === 0) {
            delete grants.grants[slug];
        }
        else {
            grants.grants[slug] = {
                namespaces: sortedNamespaces,
                grantedAt: previous?.grantedAt ?? now,
                lastUpdatedAt: now,
            };
        }
        await writeGrantsAtomic(this.grantsPath, grants);
        if (namespacesUnchanged)
            return grants;
        const previousSet = new Set(previousSorted);
        const nextSet = new Set(sortedNamespaces);
        const granted = sortedNamespaces.filter((ns) => !previousSet.has(ns));
        const revoked = previousSorted.filter((ns) => !nextSet.has(ns));
        if (granted.length > 0) {
            await appendAuditLine(this.permissionsAuditPath, {
                kind: "granted",
                timestamp: now,
                slug,
                namespaces: granted,
                actor,
            });
        }
        if (revoked.length > 0) {
            await appendAuditLine(this.permissionsAuditPath, {
                kind: "revoked",
                timestamp: now,
                slug,
                namespaces: revoked,
                actor,
            });
        }
        return grants;
    }
    getWorkerHostService() {
        if (typeof this.runtime.getService !== "function") {
            return null;
        }
        return (this.runtime.getService("app-worker-host") ?? null);
    }
    async startWorkerBestEffort(slug) {
        const hostService = this.getWorkerHostService();
        if (!hostService?.startForRegisteredApp)
            return;
        try {
            const result = await hostService.startForRegisteredApp(slug);
            if (!result.ok) {
                logger.warn(`[plugin-app-control] auto-spawn failed for slug=${slug}: ${result.reason ?? "unknown"}`);
            }
        }
        catch (error) {
            logger.warn(`[plugin-app-control] auto-spawn threw for slug=${slug}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async refreshWorkerGrantsBestEffort(entry, grantedNamespaces) {
        if (entry.isolation !== "worker")
            return;
        const hostService = this.getWorkerHostService();
        if (!hostService)
            return;
        if (hostService.stopWorker) {
            try {
                await hostService.stopWorker(entry.slug);
            }
            catch (error) {
                logger.warn(`[plugin-app-control] worker stop after grant change failed for slug=${entry.slug}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (grantedNamespaces.length > 0) {
            await this.startWorkerBestEffort(entry.slug);
        }
    }
}
function buildViewFromGrants(entry, grants) {
    const requestedPermissions = entry.requestedPermissions ?? null;
    const recognised = recognisedNamespacesForRaw(requestedPermissions);
    const grant = grants.grants[entry.slug] ?? null;
    const grantedNamespaces = grant
        ? grant.namespaces.filter((ns) => recognised.includes(ns))
        : [];
    const trust = entry.trust === "first-party" ? "first-party" : "external";
    const declaredIsolation = entry.isolation === "worker" ? "worker" : "none";
    const isolation = trust === "external" ? "worker" : declaredIsolation;
    return {
        slug: entry.slug,
        trust,
        isolation,
        requestedPermissions,
        recognisedNamespaces: recognised,
        grantedNamespaces,
        grantedAt: grant?.grantedAt ?? null,
    };
}
export default AppRegistryService;
//# sourceMappingURL=app-registry-service.js.map