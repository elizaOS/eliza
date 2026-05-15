import { promises as fs } from "node:fs";
import { ServerResponse } from "node:http";
import path from "node:path";
import { createGeneratedAppHeroSvg, hasAppInterface, PostCreateAppRequestSchema, PostInstallAppRequestSchema, PostLaunchAppRequestSchema, PostLoadFromDirectoryRequestSchema, PostOverlayPresenceRequestSchema, PostRelaunchAppRequestSchema, PostReplaceFavoritesRequestSchema, PostRunControlRequestSchema, PostRunMessageRequestSchema, PostStopAppRequestSchema, PutAppPermissionsRequestSchema, PutFavoriteAppRequestSchema, packageNameToAppDisplayName, packageNameToAppRouteSlug, parseAppIsolation, parseAppPermissions, } from "@elizaos/shared";
import { importAppRouteModule, resolveWorkspacePackageDir, } from "@elizaos/agent/services/app-package-modules";
import { setOverlayAppPresence } from "@elizaos/agent/services/overlay-app-presence";
import { scoreEntries, toSearchResults, } from "@elizaos/agent/services/registry-client-queries";
const HERO_IMAGE_CONTENT_TYPES = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
};
function readBoolFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === "")
        return fallback;
    const trimmed = String(raw).trim().toLowerCase();
    if (trimmed === "1" ||
        trimmed === "true" ||
        trimmed === "yes" ||
        trimmed === "on") {
        return true;
    }
    if (trimmed === "0" ||
        trimmed === "false" ||
        trimmed === "no" ||
        trimmed === "off") {
        return false;
    }
    return fallback;
}
function isLegacyAppsWorkspaceDiscoveryEnabled() {
    return readBoolFlag("ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY");
}
const DEFAULT_HERO_IMAGE_CANDIDATES = [
    "assets/hero.png",
    "assets/hero.webp",
    "assets/hero.jpg",
    "assets/hero.jpeg",
    "assets/hero.avif",
    "assets/hero.gif",
    "assets/hero.svg",
];
async function streamAppHero(res, absolutePath, contentType, error) {
    let data;
    try {
        data = await fs.readFile(absolutePath);
    }
    catch {
        error(res, "Hero image not found", 404);
        return;
    }
    const response = res;
    if (typeof response.writeHead === "function") {
        response.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": data.byteLength,
            "Cache-Control": "public, max-age=300",
        });
    }
    else if (typeof response.setHeader === "function") {
        response.setHeader("Content-Type", contentType);
        response.setHeader("Content-Length", data.byteLength);
        response.setHeader("Cache-Control", "public, max-age=300");
    }
    response.end?.(data);
}
function sendGeneratedAppHero(res, svg) {
    const data = Buffer.from(svg, "utf8");
    const response = res;
    if (typeof response.writeHead === "function") {
        response.writeHead(200, {
            "Content-Type": "image/svg+xml",
            "Content-Length": data.byteLength,
            "Cache-Control": "public, max-age=300",
        });
    }
    else if (typeof response.setHeader === "function") {
        response.setHeader("Content-Type", "image/svg+xml");
        response.setHeader("Content-Length", data.byteLength);
        response.setHeader("Cache-Control", "public, max-age=300");
    }
    response.end?.(data);
}
async function pathExists(absolutePath) {
    try {
        await fs.access(absolutePath);
        return true;
    }
    catch {
        return false;
    }
}
function isRelativeHeroPath(heroImage) {
    return !/^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/)/i.test(heroImage);
}
async function readPackageHeroImage(packageDir) {
    try {
        const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
        const heroImage = packageJson.elizaos?.app?.heroImage;
        return typeof heroImage === "string" ? heroImage : null;
    }
    catch {
        return null;
    }
}
async function resolveWorkspaceAppDirBySlug(slug) {
    const cwd = process.cwd();
    const roots = Array.from(new Set([
        path.resolve(cwd),
        path.resolve(cwd, ".."),
        path.resolve(cwd, "..", ".."),
    ]));
    const candidateDirs = [];
    const legacyAppsDiscovery = isLegacyAppsWorkspaceDiscoveryEnabled();
    for (const root of roots) {
        candidateDirs.push(path.join(root, "plugins", `app-${slug}`), path.join(root, "packages", `app-${slug}`));
        if (legacyAppsDiscovery) {
            candidateDirs.push(path.join(root, "apps", `app-${slug}`));
        }
        let entries = [];
        try {
            entries = await fs.readdir(root, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) {
                continue;
            }
            candidateDirs.push(path.join(root, entry.name, "plugins", `app-${slug}`), path.join(root, entry.name, "packages", `app-${slug}`));
            if (legacyAppsDiscovery) {
                // Opt-in for older external workspaces. Current Eliza app
                // plugin packages live under plugins/app-*.
                candidateDirs.push(path.join(root, entry.name, "apps", `app-${slug}`));
            }
        }
    }
    for (const candidateDir of new Set(candidateDirs.map((dir) => path.resolve(dir)))) {
        if (await pathExists(path.join(candidateDir, "package.json"))) {
            return candidateDir;
        }
    }
    return null;
}
async function resolveHeroPathFromPackageDir(packageDir, declaredHeroImage) {
    const packageHeroImage = await readPackageHeroImage(packageDir);
    const heroCandidates = Array.from(new Set([
        declaredHeroImage,
        packageHeroImage,
        ...DEFAULT_HERO_IMAGE_CANDIDATES,
    ].filter((value) => typeof value === "string" && value.trim().length > 0)));
    for (const heroImage of heroCandidates) {
        if (!isRelativeHeroPath(heroImage))
            continue;
        const extension = path.extname(heroImage).toLowerCase();
        const contentType = HERO_IMAGE_CONTENT_TYPES[extension];
        if (!contentType)
            continue;
        const absolutePath = path.resolve(packageDir, heroImage);
        const packageRoot = `${path.resolve(packageDir)}${path.sep}`;
        if (!absolutePath.startsWith(packageRoot))
            continue;
        if (!(await pathExists(absolutePath)))
            continue;
        return { absolutePath, contentType };
    }
    return null;
}
async function resolveAppHero(pluginManager, slug) {
    const registry = await pluginManager.refreshRegistry();
    for (const entry of registry.values()) {
        const entrySlugs = new Set();
        const nameSlug = packageNameToAppRouteSlug(entry.name);
        const npmSlug = packageNameToAppRouteSlug(entry.npm.package);
        if (nameSlug)
            entrySlugs.add(nameSlug);
        if (npmSlug)
            entrySlugs.add(npmSlug);
        if (!entrySlugs.has(slug))
            continue;
        const packageDirs = new Set();
        if (entry.localPath) {
            packageDirs.add(path.resolve(entry.localPath));
        }
        const workspacePackageDir = await resolveWorkspacePackageDir(entry.npm.package);
        if (workspacePackageDir) {
            packageDirs.add(path.resolve(workspacePackageDir));
        }
        const workspaceSlugDir = await resolveWorkspaceAppDirBySlug(slug);
        if (workspaceSlugDir) {
            packageDirs.add(path.resolve(workspaceSlugDir));
        }
        for (const packageDir of packageDirs) {
            const resolved = await resolveHeroPathFromPackageDir(packageDir, entry.appMeta?.heroImage ?? null);
            if (resolved) {
                return { kind: "file", ...resolved };
            }
        }
        return {
            kind: "generated",
            svg: createGeneratedAppHeroSvg({
                name: entry.name,
                displayName: entry.appMeta?.displayName ?? packageNameToAppDisplayName(entry.name),
                category: entry.appMeta?.category ?? "app",
                description: entry.description,
            }),
        };
    }
    return null;
}
function sanitizeFavoriteAppNames(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const apps = [];
    for (const item of value) {
        if (typeof item !== "string")
            continue;
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        apps.push(trimmed);
    }
    return apps;
}
function isNonAppRegistryPlugin(plugin) {
    return !hasAppInterface(plugin);
}
function actionResultStatus(result) {
    if (result &&
        typeof result === "object" &&
        "success" in result &&
        result.success === false) {
        return 404;
    }
    return 200;
}
function createCapturedResponse() {
    const headers = new Map();
    let body = "";
    let statusCode = 200;
    const response = {
        get statusCode() {
            return statusCode;
        },
        set statusCode(value) {
            statusCode = value;
        },
        headers: Object.create(null),
        body,
        setHeader(name, value) {
            const normalized = Array.isArray(value)
                ? value.join(", ")
                : String(value);
            headers.set(name.toLowerCase(), normalized);
            response.headers[name.toLowerCase()] = normalized;
        },
        getHeader(name) {
            return headers.get(name.toLowerCase());
        },
        removeHeader(name) {
            headers.delete(name.toLowerCase());
            delete response.headers[name.toLowerCase()];
        },
        writeHead(nextStatusCode, nextHeaders) {
            statusCode = nextStatusCode;
            if (nextHeaders) {
                for (const [name, value] of Object.entries(nextHeaders)) {
                    response.setHeader(name, value.toString());
                }
            }
            return response;
        },
        end(chunk) {
            if (chunk === undefined || chunk === null) {
                response.body = body;
                return;
            }
            body += Buffer.isBuffer(chunk)
                ? chunk.toString("utf8")
                : typeof chunk === "string"
                    ? chunk
                    : String(chunk);
            response.body = body;
        },
    };
    return response;
}
function parseCapturedBody(body) {
    const trimmed = body.trim();
    if (!trimmed)
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
function isAppRunSummary(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.runId === "string" &&
        typeof value.appName === "string" &&
        typeof value.displayName === "string");
}
function resolveRunSteeringTarget(run, subroute) {
    const routeSlug = packageNameToAppRouteSlug(run.appName) ?? run.appName;
    if (!routeSlug)
        return null;
    if (routeSlug === "babylon") {
        if (subroute === "message") {
            return {
                pathname: `/api/apps/${encodeURIComponent(routeSlug)}/agent/chat`,
            };
        }
        if (subroute === "control") {
            return {
                pathname: `/api/apps/${encodeURIComponent(routeSlug)}/agent/toggle`,
            };
        }
        return null;
    }
    if (!run.session?.sessionId) {
        return null;
    }
    return {
        pathname: `/api/apps/${encodeURIComponent(routeSlug)}/session/${encodeURIComponent(run.session.sessionId)}/${subroute}`,
    };
}
function buildSteeringDisposition(run, subroute, upstreamStatus, upstreamBody) {
    const upstreamMessage = typeof upstreamBody?.message === "string"
        ? upstreamBody.message.toLowerCase()
        : typeof upstreamBody?.error === "string"
            ? upstreamBody.error.toLowerCase()
            : "";
    const upstreamDisposition = upstreamBody?.disposition;
    if (upstreamDisposition === "accepted" ||
        upstreamDisposition === "queued" ||
        upstreamDisposition === "rejected" ||
        upstreamDisposition === "unsupported") {
        return upstreamDisposition;
    }
    if (upstreamStatus === 202)
        return "queued";
    if (upstreamStatus === 404) {
        return upstreamMessage.includes("not found") ||
            upstreamMessage.includes("not available") ||
            upstreamMessage.includes("unavailable")
            ? "unsupported"
            : "rejected";
    }
    if (upstreamStatus >= 500)
        return "unsupported";
    if (upstreamStatus >= 400)
        return "rejected";
    const success = upstreamBody?.success === true || upstreamBody?.ok === true;
    if (!success) {
        return upstreamStatus >= 500 ? "unsupported" : "rejected";
    }
    if (run.appName === "@elizaos/plugin-2004scape" && subroute === "message") {
        return "queued";
    }
    return "accepted";
}
function buildUnsupportedSteeringResult(run, subroute, reason) {
    // "messaging is" (mass noun) vs "controls are" (plural) — preserve the
    // grammar of the original inline strings this helper replaced.
    const channel = subroute === "message" ? "messaging" : "controls";
    const verb = subroute === "message" ? "is" : "are";
    const message = reason === "no-handler"
        ? `Run-scoped ${channel} ${verb} unavailable for "${run.displayName}" because its route module does not expose a steering handler.`
        : `Run-scoped ${channel} ${verb} unavailable for "${run.displayName}".`;
    return {
        success: false,
        message,
        disposition: "unsupported",
        status: 501,
        run,
        session: run.session ?? null,
    };
}
function buildSyntheticSteeringContext(ctx, targetPathname, body) {
    const captured = createCapturedResponse();
    const syntheticResponse = Object.assign(Object.create(ServerResponse.prototype), captured);
    const syntheticUrl = new URL(ctx.url.toString());
    syntheticUrl.pathname = targetPathname;
    const syntheticCtx = {
        ...ctx,
        pathname: targetPathname,
        url: syntheticUrl,
        res: syntheticResponse,
        readJsonBody: async () => body,
        json: (response, data, status = 200) => {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(JSON.stringify(data));
        },
        error: (response, message, status = 500) => {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: message }));
        },
    };
    return { ctx: syntheticCtx, captured };
}
function resolveSteeringOutcome(disposition, capturedStatusCode, upstreamBody) {
    const success = upstreamBody?.success === true || upstreamBody?.ok === true
        ? true
        : disposition === "accepted" || disposition === "queued";
    const message = typeof upstreamBody?.message === "string" && upstreamBody.message.trim()
        ? upstreamBody.message.trim()
        : disposition === "queued"
            ? "Command queued."
            : disposition === "accepted"
                ? "Command accepted."
                : disposition === "unsupported"
                    ? "This run does not support that steering channel."
                    : "Command rejected.";
    const status = disposition === "queued"
        ? 202
        : disposition === "rejected" && capturedStatusCode < 400
            ? 409
            : disposition === "unsupported"
                ? Math.max(capturedStatusCode, 501)
                : capturedStatusCode;
    return { success, message, status };
}
async function proxyRunSteeringRequest(ctx, run, subroute, body) {
    const target = resolveRunSteeringTarget(run, subroute);
    if (!target) {
        return buildUnsupportedSteeringResult(run, subroute, "no-target");
    }
    const routeModule = await importAppRouteModule(run.appName);
    if (typeof routeModule?.handleAppRoutes !== "function") {
        return buildUnsupportedSteeringResult(run, subroute, "no-handler");
    }
    const { ctx: syntheticCtx, captured } = buildSyntheticSteeringContext(ctx, target.pathname, body);
    const handled = await routeModule.handleAppRoutes(syntheticCtx);
    if (!handled) {
        return buildUnsupportedSteeringResult(run, subroute, "no-target");
    }
    const upstreamBody = parseCapturedBody(captured.body);
    const refreshedRunCandidate = await ctx.appManager.getRun(run.runId, ctx.runtime);
    const refreshedRun = isAppRunSummary(refreshedRunCandidate)
        ? refreshedRunCandidate
        : run;
    const disposition = buildSteeringDisposition(refreshedRun, subroute, captured.statusCode, upstreamBody);
    const { success, message, status } = resolveSteeringOutcome(disposition, captured.statusCode, upstreamBody);
    return {
        success,
        message,
        disposition,
        status,
        run: refreshedRun,
        session: upstreamBody?.session ??
            refreshedRun.session ??
            null,
    };
}
export async function handleAppsRoutes(ctx) {
    const { req, res, method, pathname, url, appManager, getPluginManager, parseBoundedLimit, readJsonBody, json, error, runtime, } = ctx;
    if (method === "GET" && pathname === "/api/apps") {
        const pluginManager = getPluginManager();
        const apps = await appManager.listAvailable(pluginManager);
        json(res, apps);
        return true;
    }
    if (method === "GET" && pathname.startsWith("/api/apps/hero/")) {
        const slug = decodeURIComponent(pathname.slice("/api/apps/hero/".length)).trim();
        if (!slug) {
            error(res, "app slug is required", 400);
            return true;
        }
        const pluginManager = getPluginManager();
        const resolved = await resolveAppHero(pluginManager, slug);
        if (!resolved) {
            error(res, `Hero image for "${slug}" is not available`, 404);
            return true;
        }
        if (resolved.kind === "file") {
            await streamAppHero(res, resolved.absolutePath, resolved.contentType, error);
        }
        else {
            sendGeneratedAppHero(res, resolved.svg);
        }
        return true;
    }
    if (method === "GET" && pathname === "/api/apps/search") {
        const query = url.searchParams.get("q") ?? "";
        if (!query.trim()) {
            json(res, []);
            return true;
        }
        const limit = parseBoundedLimit(url.searchParams.get("limit"));
        const pluginManager = getPluginManager();
        const results = await appManager.search(pluginManager, query, limit);
        json(res, results);
        return true;
    }
    if (method === "GET" && pathname === "/api/apps/installed") {
        const pluginManager = getPluginManager();
        const installed = await appManager.listInstalled(pluginManager);
        json(res, installed);
        return true;
    }
    if (pathname === "/api/apps/favorites") {
        const store = ctx.favoriteApps;
        if (!store) {
            error(res, "Favorites store is not configured", 503);
            return true;
        }
        if (method === "GET") {
            const response = { favoriteApps: store.read() };
            json(res, response);
            return true;
        }
        if (method === "PUT") {
            const rawBody = await readJsonBody(req, res);
            if (rawBody === null)
                return true;
            const parsed = PutFavoriteAppRequestSchema.safeParse(rawBody);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                const issuePath = issue?.path.join(".");
                error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
                return true;
            }
            const { appName, isFavorite } = parsed.data;
            const current = store.read();
            const filtered = current.filter((entry) => entry !== appName);
            const next = isFavorite ? [...filtered, appName] : filtered;
            const persisted = store.write(sanitizeFavoriteAppNames(next));
            const response = { favoriteApps: persisted };
            json(res, response);
            return true;
        }
    }
    if (method === "POST" && pathname === "/api/apps/favorites/replace") {
        const store = ctx.favoriteApps;
        if (!store) {
            error(res, "Favorites store is not configured", 503);
            return true;
        }
        const rawBody = await readJsonBody(req, res);
        if (rawBody === null)
            return true;
        const parsed = PostReplaceFavoritesRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const issuePath = issue?.path.join(".");
            error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
            return true;
        }
        const sanitized = sanitizeFavoriteAppNames(parsed.data.favoriteAppNames);
        const persisted = store.write(sanitized);
        const response = { favoriteApps: persisted };
        json(res, response);
        return true;
    }
    if (method === "GET" && pathname === "/api/apps/runs") {
        const runs = await appManager.listRuns(runtime);
        json(res, runs);
        return true;
    }
    // Dashboard heartbeat for overlay apps (companion, etc.) — no AppManager run.
    if (method === "POST" && pathname === "/api/apps/overlay-presence") {
        const rawBody = await readJsonBody(req, res);
        if (rawBody === null)
            return true;
        const parsed = PostOverlayPresenceRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const issuePath = issue?.path.join(".");
            error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
            return true;
        }
        const { appName } = parsed.data;
        setOverlayAppPresence(appName);
        const response = { ok: true, appName };
        json(res, response);
        return true;
    }
    if (method === "GET" && pathname.startsWith("/api/apps/runs/")) {
        const parts = pathname.split("/").filter(Boolean);
        const runId = parts[3] ? decodeURIComponent(parts[3]) : "";
        const subroute = parts[4] ?? "";
        if (!runId) {
            error(res, "runId is required");
            return true;
        }
        if (!subroute) {
            const run = await appManager.getRun(runId, runtime);
            if (!run) {
                error(res, `App run "${runId}" not found`, 404);
                return true;
            }
            json(res, run);
            return true;
        }
        if (subroute === "health") {
            const run = await appManager.getRun(runId, runtime);
            if (!run || typeof run !== "object" || run === null) {
                error(res, `App run "${runId}" not found`, 404);
                return true;
            }
            const health = "health" in run ? run.health : null;
            json(res, health);
            return true;
        }
    }
    if (method === "POST" && pathname.startsWith("/api/apps/runs/")) {
        const parts = pathname.split("/").filter(Boolean);
        const runId = parts[3] ? decodeURIComponent(parts[3]) : "";
        const subroute = parts[4] ?? "";
        if (!runId || !subroute) {
            error(res, "runId is required");
            return true;
        }
        if (subroute === "attach") {
            const result = await appManager.attachRun(runId, runtime);
            json(res, result, actionResultStatus(result));
            return true;
        }
        if (subroute === "message" || subroute === "control") {
            const run = (await appManager.getRun(runId, runtime));
            if (!run) {
                error(res, `App run "${runId}" not found`, 404);
                return true;
            }
            const rawBody = await readJsonBody(req, res);
            if (rawBody === null)
                return true;
            const parsed = subroute === "message"
                ? PostRunMessageRequestSchema.safeParse(rawBody)
                : PostRunControlRequestSchema.safeParse(rawBody);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                const issuePath = issue?.path.join(".");
                error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
                return true;
            }
            const result = await proxyRunSteeringRequest(ctx, run, subroute, parsed.data);
            if (!result) {
                error(res, "Run steering failed", 500);
                return true;
            }
            json(res, result, result.status);
            return true;
        }
        if (subroute === "detach") {
            const result = await appManager.detachRun(runId);
            json(res, result, actionResultStatus(result));
            return true;
        }
        if (subroute === "stop") {
            const pluginManager = getPluginManager();
            const result = await appManager.stop(pluginManager, "", runId, null);
            json(res, result);
            return true;
        }
        if (subroute === "heartbeat") {
            // Cheap liveness ping from the UI — does not invoke any plugin route
            // or talk to the upstream game API. The stale-run sweeper relies on
            // this so the moment a tab closes the heartbeat dries up and the
            // run gets reaped via the same `stopRun` hook the Stop button uses.
            //
            // Returns 200 + the refreshed run so the client can also use this as
            // a low-cost confirmation that the run still exists; returns 404 if
            // the run has already been stopped (so the UI can detect a Stop
            // initiated from another window or by the sweeper).
            const refreshed = appManager.recordHeartbeat(runId);
            if (!refreshed) {
                error(res, `App run "${runId}" not found`, 404);
                return true;
            }
            json(res, { ok: true, run: refreshed });
            return true;
        }
    }
    if (method === "POST" && pathname === "/api/apps/launch") {
        try {
            const rawBody = await readJsonBody(req, res);
            if (rawBody === null)
                return true;
            const parsed = PostLaunchAppRequestSchema.safeParse(rawBody);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                const issuePath = issue?.path.join(".");
                error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
                return true;
            }
            const pluginManager = getPluginManager();
            const result = await appManager.launch(pluginManager, parsed.data.name, (_progress) => { }, runtime);
            json(res, result);
        }
        catch (e) {
            error(res, e instanceof Error ? e.message : "Failed to launch app", 500);
        }
        return true;
    }
    if (method === "POST" && pathname === "/api/apps/install") {
        try {
            const rawBody = await readJsonBody(req, res);
            if (rawBody === null)
                return true;
            const parsed = PostInstallAppRequestSchema.safeParse(rawBody);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                const issuePath = issue?.path.join(".");
                error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
                return true;
            }
            const { name, version } = parsed.data;
            const progressEvents = [];
            const recordProgress = (progress) => {
                progressEvents.push(progress);
            };
            const pluginManager = getPluginManager();
            let result = await pluginManager
                .installPlugin(name, recordProgress, version ? { version } : undefined)
                .catch((err) => ({
                success: false,
                pluginName: name,
                version: "",
                installPath: "",
                requiresRestart: false,
                error: err instanceof Error ? err.message : String(err),
            }));
            if (!result.success &&
                result.error?.includes("requires a running agent runtime")) {
                // Fall back to the direct installer which writes directly to
                // ~/.eliza/plugins/installed without depending on a plugin-manager
                // service. The runtime plugin resolver already searches that dir.
                const { installPlugin: installPluginDirect } = await import("@elizaos/plugin-registry");
                result = await installPluginDirect(name, recordProgress, version);
            }
            if (!result.success) {
                const failure = {
                    success: false,
                    ...(result.error ? { error: result.error } : {}),
                    progress: progressEvents,
                };
                json(res, failure, 422);
                return true;
            }
            const success = {
                success: true,
                pluginName: result.pluginName,
                version: result.version,
                installPath: result.installPath,
                requiresRestart: result.requiresRestart,
                progress: progressEvents,
            };
            json(res, success);
        }
        catch (e) {
            error(res, e instanceof Error ? e.message : "Failed to install app", 500);
        }
        return true;
    }
    if (method === "POST" && pathname === "/api/apps/stop") {
        const rawBody = await readJsonBody(req, res);
        if (rawBody === null)
            return true;
        const parsed = PostStopAppRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const issuePath = issue?.path.join(".");
            error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
            return true;
        }
        const appName = parsed.data.name ?? "";
        const runId = parsed.data.runId;
        const pluginManager = getPluginManager();
        const result = await appManager.stop(pluginManager, appName, runId);
        json(res, result);
        return true;
    }
    if (method === "GET" && pathname.startsWith("/api/apps/info/")) {
        const appName = decodeURIComponent(pathname.slice("/api/apps/info/".length));
        if (!appName) {
            error(res, "app name is required");
            return true;
        }
        const pluginManager = getPluginManager();
        const info = await appManager.getInfo(pluginManager, appName);
        if (!info) {
            error(res, `App "${appName}" not found in registry`, 404);
            return true;
        }
        json(res, info);
        return true;
    }
    if (method === "GET" && pathname === "/api/apps/plugins") {
        try {
            const pluginManager = getPluginManager();
            const registry = await pluginManager.refreshRegistry();
            const plugins = Array.from(registry.values()).filter(isNonAppRegistryPlugin);
            json(res, plugins);
        }
        catch (err) {
            error(res, `Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`, 502);
        }
        return true;
    }
    if (method === "GET" && pathname === "/api/apps/plugins/search") {
        const query = url.searchParams.get("q") ?? "";
        if (!query.trim()) {
            json(res, []);
            return true;
        }
        try {
            const limit = parseBoundedLimit(url.searchParams.get("limit"));
            const pluginManager = getPluginManager();
            const registry = await pluginManager.refreshRegistry();
            const results = scoreEntries(Array.from(registry.values()).filter(isNonAppRegistryPlugin), query, limit);
            json(res, toSearchResults(results));
        }
        catch (err) {
            error(res, `Plugin search failed: ${err instanceof Error ? err.message : String(err)}`, 502);
        }
        return true;
    }
    if (method === "POST" && pathname === "/api/apps/refresh") {
        try {
            const pluginManager = getPluginManager();
            const registry = await pluginManager.refreshRegistry();
            const count = Array.from(registry.values()).filter(isNonAppRegistryPlugin).length;
            const response = { ok: true, count };
            json(res, response);
        }
        catch (err) {
            error(res, `Refresh failed: ${err instanceof Error ? err.message : String(err)}`, 502);
        }
        return true;
    }
    // -------------------------------------------------------------------------
    // Unified APP-action HTTP surface (relaunch / load-from-directory / create)
    //
    // These endpoints pair with the in-process @elizaos/plugin-app-control APP
    // action sub-modes. They live here so dashboard UIs and platform connectors
    // can reach the same behaviour without going through the chat planner.
    // -------------------------------------------------------------------------
    if (method === "POST" && pathname === "/api/apps/relaunch") {
        const rawBody = await readJsonBody(req, res);
        if (rawBody === null)
            return true;
        const parsed = PostRelaunchAppRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const issuePath = issue?.path.join(".");
            error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
            return true;
        }
        const { name, runId, verify: verifyRequested } = parsed.data;
        const pluginManager = getPluginManager();
        try {
            // Stop matching runs first.
            if (runId) {
                await appManager.stop(pluginManager, "", runId, null);
            }
            else {
                await appManager.stop(pluginManager, name, undefined, null);
            }
            const launch = await appManager.launch(pluginManager, name, (_progress) => { }, runtime);
            let verify = null;
            if (verifyRequested === true) {
                const runtimeWithServices = runtime;
                const verificationService = runtimeWithServices?.getService?.("app-verification") ?? null;
                if (verificationService?.verifyApp) {
                    // Workdir is unknown server-side; verification needs the app's
                    // source dir which we cannot infer from a name alone, so we record
                    // skip rather than guess. Callers that need verification should
                    // route through the in-process APP action with an explicit workdir.
                    verify = {
                        verdict: "skipped",
                        retryablePromptForChild: "Verification requires a workdir; relaunch endpoint cannot infer one.",
                    };
                }
            }
            const response = { launch, verify };
            json(res, response);
        }
        catch (err) {
            error(res, `Relaunch failed: ${err instanceof Error ? err.message : String(err)}`, 500);
        }
        return true;
    }
    if (method === "GET" && pathname === "/api/apps/permissions") {
        const runtimeWithList = runtime;
        const registry = runtimeWithList?.getService?.("app-registry") ?? null;
        if (!registry?.listPermissionsViews) {
            error(res, "AppRegistryService is not registered on the runtime", 503);
            return true;
        }
        const views = await registry.listPermissionsViews();
        json(res, views);
        return true;
    }
    if ((method === "GET" || method === "PUT") &&
        pathname.startsWith("/api/apps/permissions/")) {
        const slug = decodeURIComponent(pathname.slice("/api/apps/permissions/".length));
        if (!slug || slug.includes("/")) {
            error(res, "slug is required");
            return true;
        }
        const runtimeWithRegistry = runtime;
        const registry = runtimeWithRegistry?.getService?.("app-registry") ?? null;
        if (!registry?.getPermissionsView || !registry.setGrantedNamespaces) {
            error(res, "AppRegistryService is not registered on the runtime", 503);
            return true;
        }
        if (method === "GET") {
            const view = await registry.getPermissionsView(slug);
            if (view === null || view === undefined) {
                error(res, `No app registered under slug=${slug}`, 404);
                return true;
            }
            json(res, view);
            return true;
        }
        // PUT — replace granted namespaces. Body validation goes through
        // the zod schema in @elizaos/shared so the wire shape is the
        // single source of truth (see contracts/app-permissions-routes.ts).
        const rawBody = await readJsonBody(req, res);
        if (rawBody === null)
            return true;
        const parsed = PutAppPermissionsRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const path = issue?.path.join(".");
            error(res, `Invalid request body at ${path}: ${issue?.message}`, 400);
            return true;
        }
        const result = await registry.setGrantedNamespaces(slug, parsed.data.namespaces, "user");
        if (result.ok === false) {
            const status = result.reason.startsWith("No app registered") ? 404 : 400;
            error(res, result.reason, status);
            return true;
        }
        json(res, result.view);
        return true;
    }
    if (method === "POST" && pathname === "/api/apps/load-from-directory") {
        // Body validation goes through PostLoadFromDirectoryRequestSchema
        // (zod, see @elizaos/shared/contracts/apps-loading-routes.ts).
        // The schema handles the required check, the absolute-path check,
        // and rejects extra unknown fields via .strict().
        const rawBody = await readJsonBody(req, res);
        if (rawBody === null)
            return true;
        const parsed = PostLoadFromDirectoryRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const path = issue?.path.join(".");
            error(res, `Invalid request body at ${path}: ${issue?.message}`, 400);
            return true;
        }
        const directory = parsed.data.directory;
        const runtimeWithServices = runtime;
        const registry = runtimeWithServices?.getService?.("app-registry") ?? null;
        if (!registry?.register) {
            error(res, "AppRegistryService is not registered on the runtime", 503);
            return true;
        }
        try {
            const entries = await fs.readdir(directory, { withFileTypes: true });
            let registered = 0;
            const items = [];
            const rejectedManifests = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const subdir = path.join(directory, entry.name);
                const pkgPath = path.join(subdir, "package.json");
                const raw = await fs.readFile(pkgPath, "utf8").catch(() => null);
                if (raw === null)
                    continue;
                const parsed = JSON.parse(raw);
                const elizaos = parsed.elizaos && typeof parsed.elizaos === "object"
                    ? parsed.elizaos
                    : null;
                const appMeta = elizaos?.app && typeof elizaos.app === "object"
                    ? elizaos.app
                    : null;
                if (!appMeta)
                    continue;
                const packageName = typeof parsed.name === "string" ? parsed.name : null;
                if (!packageName)
                    continue;
                const permissionsResult = parseAppPermissions(appMeta.permissions);
                if (permissionsResult.ok === false) {
                    const rejection = {
                        directory: subdir,
                        packageName,
                        reason: permissionsResult.reason,
                        path: permissionsResult.path,
                    };
                    rejectedManifests.push(rejection);
                    await registry.recordManifestRejection?.({
                        ...rejection,
                        requesterEntityId: null,
                        requesterRoomId: null,
                    });
                    continue;
                }
                const basename = packageName.replace(/^@[^/]+\//, "").trim();
                const slug = (typeof appMeta.slug === "string" && appMeta.slug.trim()) ||
                    basename.replace(/^app-/, "");
                const displayName = (typeof appMeta.displayName === "string" &&
                    appMeta.displayName.trim()) ||
                    basename;
                const aliases = Array.isArray(appMeta.aliases)
                    ? appMeta.aliases.filter((v) => typeof v === "string")
                    : [];
                const entryRecord = {
                    slug,
                    canonicalName: packageName,
                    aliases,
                    directory: subdir,
                    displayName,
                    isolation: parseAppIsolation(appMeta.isolation),
                };
                if (permissionsResult.manifest.raw !== null) {
                    entryRecord.requestedPermissions = permissionsResult.manifest.raw;
                }
                await registry.register(entryRecord, {
                    requesterEntityId: null,
                    requesterRoomId: null,
                    trust: "external",
                });
                registered += 1;
                items.push({ slug, canonicalName: packageName });
            }
            json(res, {
                ok: true,
                directory,
                registered,
                items,
                rejectedManifests,
            });
        }
        catch (err) {
            error(res, `Load failed: ${err instanceof Error ? err.message : String(err)}`, 500);
        }
        return true;
    }
    if (method === "POST" && pathname === "/api/apps/create") {
        const rawBody = await readJsonBody(req, res);
        if (rawBody === null)
            return true;
        const parsed = PostCreateAppRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const issuePath = issue?.path.join(".");
            error(res, `Invalid request body at ${issuePath}: ${issue?.message}`, 400);
            return true;
        }
        const { intent, editTarget } = parsed.data;
        const runtimeWithActions = runtime;
        const appAction = runtimeWithActions?.actions?.find((a) => a.name === "APP") ?? null;
        if (!appAction) {
            error(res, "APP action is not registered on the runtime", 503);
            return true;
        }
        try {
            const lines = [];
            const callback = async (content) => {
                if (typeof content.text === "string" && content.text.length > 0) {
                    lines.push(content.text);
                }
                return [];
            };
            const fakeMessage = {
                entityId: runtimeWithActions?.agentId ?? "system",
                roomId: runtimeWithActions?.agentId ?? "system",
                agentId: runtimeWithActions?.agentId ?? "system",
                content: { text: intent },
            };
            const result = (await appAction.handler(runtime, fakeMessage, undefined, {
                parameters: {
                    mode: "create",
                    intent,
                    ...(editTarget ? { editTarget } : {}),
                },
                mode: "create",
                intent,
                ...(editTarget ? { editTarget } : {}),
            }, callback));
            const response = {
                success: result?.success !== false,
                text: result?.text ?? lines.join("\n"),
                messages: lines,
                data: result?.data ?? null,
            };
            json(res, response);
        }
        catch (err) {
            error(res, `Create failed: ${err instanceof Error ? err.message : String(err)}`, 500);
        }
        return true;
    }
    return false;
}
