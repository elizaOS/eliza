/**
 * PR 2 runtime smoke test for `@elizaos/app-scape`.
 *
 * Things the eliza host would do when loading the plugin, short of
 * actually starting the full runtime:
 *
 *   1. Import the plugin's default export and check the shape matches
 *      what the host expects (`name`, `app.displayName`, etc.).
 *   2. Import the routes module and verify `handleAppRoutes` +
 *      `resolveLaunchSession` are callable.
 *   3. Call `handleAppRoutes` with a synthetic GET /viewer request and
 *      verify the response is an HTML page containing an iframe that
 *      points at the expected xRSPS client URL.
 *   4. Verify `scape` resolves through
 *      `ELIZA_CURATED_APP_DEFINITIONS` helper lookups — the same
 *      lookup the app manager does when surfacing the apps grid.
 *
 * Run: bun eliza/apps/app-scape/scripts/verify-pr2.ts
 */

import {
    ELIZA_CURATED_APP_DEFINITIONS,
    getElizaCuratedAppDefinition,
    isElizaCuratedAppName,
    normalizeElizaCuratedAppName,
} from "@elizaos/shared/contracts/apps";
import appScapePlugin, {
    createAppScapePlugin,
} from "@elizaos/app-scape";
import {
    handleAppRoutes,
    refreshRunSession,
    resolveLaunchSession,
} from "@elizaos/app-scape/routes";

interface MockResponse {
    statusCode: number;
    headers: Map<string, string>;
    body: string;
    statusCodeFinal: number;
    setHeader(name: string, value: string): void;
    removeHeader(name: string): void;
    getHeader(name: string): string | undefined;
    end(body?: string): void;
}

function createMockResponse(): MockResponse {
    const response: MockResponse = {
        statusCode: 0,
        headers: new Map(),
        body: "",
        statusCodeFinal: 0,
        setHeader(name, value) {
            this.headers.set(name.toLowerCase(), value);
        },
        removeHeader(name) {
            this.headers.delete(name.toLowerCase());
        },
        getHeader(name) {
            return this.headers.get(name.toLowerCase());
        },
        end(body) {
            this.body = body ?? "";
            this.statusCodeFinal = this.statusCode;
        },
    };
    return response;
}

function assertTrue(label: string, ok: boolean): void {
    if (ok) {
        console.log(`  ✓ ${label}`);
    } else {
        console.log(`  ✗ ${label}`);
        process.exitCode = 1;
    }
}

async function main(): Promise<void> {
    console.log("[verify-pr2] starting");

    // 1. Plugin export shape
    console.log("\n[1] plugin export shape");
    assertTrue("default export is truthy", appScapePlugin != null);
    assertTrue(
        "plugin name = @elizaos/app-scape",
        appScapePlugin.name === "@elizaos/app-scape",
    );
    assertTrue("plugin has app metadata", appScapePlugin.app != null);
    assertTrue(
        "app.displayName = 'scape",
        appScapePlugin.app?.displayName === "'scape",
    );
    assertTrue(
        "app.launchType = connect",
        appScapePlugin.app?.launchType === "connect",
    );
    assertTrue(
        "app.viewer.url = /api/apps/scape/viewer",
        appScapePlugin.app?.viewer?.url === "/api/apps/scape/viewer",
    );
    assertTrue(
        "app.capabilities includes autonomous",
        appScapePlugin.app?.capabilities?.includes("autonomous") === true,
    );

    // 2. Factory is callable and returns the same shape
    console.log("\n[2] factory");
    const freshPlugin = createAppScapePlugin();
    assertTrue(
        "createAppScapePlugin() returns fresh instance with same name",
        freshPlugin.name === appScapePlugin.name,
    );

    // 3. Routes module — viewer HTML
    console.log("\n[3] GET /api/apps/scape/viewer");
    const res = createMockResponse();
    let errorCalled = false;
    const handled = await handleAppRoutes({
        method: "GET",
        pathname: "/api/apps/scape/viewer",
        runtime: null,
        error: () => {
            errorCalled = true;
        },
        json: () => {},
        readJsonBody: async () => null,
        res,
    });
    assertTrue("handler returned true", handled === true);
    assertTrue("error callback NOT called", errorCalled === false);
    assertTrue(
        "response statusCode = 200",
        res.statusCodeFinal === 200,
    );
    assertTrue(
        "response Content-Type is text/html",
        (res.getHeader("Content-Type") ?? "").includes("text/html"),
    );
    // The viewer intentionally does NOT opt into cross-origin isolation.
    // The xRSPS client *wants* SharedArrayBuffer, but require-corp blocks
    // any iframe whose origin doesn't send Cross-Origin-Resource-Policy —
    // and the live Sevalla deployment at scape-client-2sqyc.kinsta.page
    // doesn't. With COEP on, WebKit silently blocks the iframe and the
    // "xRSPS client is not reachable" fallback trips. Until infra adds
    // CORP headers upstream, manual play requires no COOP/COEP/CORP here.
    assertTrue(
        "response does NOT opt into cross-origin isolation",
        res.getHeader("Cross-Origin-Opener-Policy") === undefined &&
            res.getHeader("Cross-Origin-Embedder-Policy") === undefined &&
            res.getHeader("Cross-Origin-Resource-Policy") === undefined,
    );
    assertTrue(
        "response CSP includes frame-ancestors",
        /\bframe-ancestors\b/i.test(res.getHeader("Content-Security-Policy") ?? ""),
    );
    assertTrue(
        "body contains iframe pointing at default deployed 'scape client",
        res.body.includes('id="scape-frame"') &&
            res.body.includes("https://scape-client-2sqyc.kinsta.page"),
    );
    assertTrue(
        "body contains fallback block",
        res.body.includes("xRSPS client is not reachable"),
    );

    // 4. SCAPE_CLIENT_URL env override is honored
    console.log("\n[4] SCAPE_CLIENT_URL env override");
    process.env.SCAPE_CLIENT_URL = "https://example.test/custom-scape";
    const res2 = createMockResponse();
    await handleAppRoutes({
        method: "GET",
        pathname: "/api/apps/scape/viewer",
        runtime: null,
        error: () => {},
        json: () => {},
        readJsonBody: async () => null,
        res: res2,
    });
    assertTrue(
        "iframe src reflects SCAPE_CLIENT_URL override",
        res2.body.includes("https://example.test/custom-scape"),
    );
    delete process.env.SCAPE_CLIENT_URL;

    // 5. Unknown routes pass through (return false)
    console.log("\n[5] unknown routes pass through");
    const res3 = createMockResponse();
    const notHandled = await handleAppRoutes({
        method: "GET",
        pathname: "/api/apps/scape/does-not-exist",
        runtime: null,
        error: () => {},
        json: () => {},
        readJsonBody: async () => null,
        res: res3,
    });
    assertTrue("handler returned false for unknown subroute", notHandled === false);

    // 6. Session resolvers
    console.log("\n[6] session resolvers");
    const launchSession = await resolveLaunchSession({
        appName: "@elizaos/app-scape",
        launchUrl: null,
        runtime: null,
        viewer: null,
    });
    assertTrue("resolveLaunchSession returns a session", launchSession != null);
    assertTrue(
        "session.appName = @elizaos/app-scape",
        launchSession?.appName === "@elizaos/app-scape",
    );
    assertTrue(
        "session.mode = spectate-and-steer",
        launchSession?.mode === "spectate-and-steer",
    );

    const refreshSession = await refreshRunSession({
        appName: "@elizaos/app-scape",
        launchUrl: null,
        runtime: null,
        viewer: null,
        runId: "test-run",
        session: null,
    });
    assertTrue("refreshRunSession returns a session", refreshSession != null);

    // 7. Curated registry integration
    console.log("\n[7] curated registry integration");
    const scapeEntry = ELIZA_CURATED_APP_DEFINITIONS.find(
        (def) => def.canonicalName === "@elizaos/app-scape",
    );
    assertTrue("scape in ELIZA_CURATED_APP_DEFINITIONS", scapeEntry != null);
    assertTrue(
        "scape slug = 'scape'",
        scapeEntry?.slug === "scape",
    );
    assertTrue(
        "isElizaCuratedAppName('@elizaos/app-scape')",
        isElizaCuratedAppName("@elizaos/app-scape"),
    );
    assertTrue(
        "isElizaCuratedAppName('scape') via slug",
        isElizaCuratedAppName("scape"),
    );
    assertTrue(
        "normalizeElizaCuratedAppName('scape') → @elizaos/app-scape",
        normalizeElizaCuratedAppName("scape") === "@elizaos/app-scape",
    );
    const byDef = getElizaCuratedAppDefinition("scape");
    assertTrue("getElizaCuratedAppDefinition('scape')", byDef != null);
    // The curated list grows over time as new apps land on develop. What
    // this PR actually needs to prove is that `scape` is present — not
    // that the list is exactly a particular length. Hardcoding a count
    // here gave a false negative every time an unrelated app was added.
    assertTrue(
        "curated list contains scape",
        ELIZA_CURATED_APP_DEFINITIONS.some((d) => d.slug === "scape"),
    );

    if (process.exitCode === 1) {
        console.log("\n[verify-pr2] FAILED");
    } else {
        console.log("\n[verify-pr2] PASSED");
    }
}

main().catch((err) => {
    console.error("[verify-pr2] fatal:", err);
    process.exit(2);
});
