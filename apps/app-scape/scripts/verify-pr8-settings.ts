/**
 * PR 8 settings verification — drives the exact same code path the
 * eliza UI uses to populate `/api/secrets`, and asserts the scape
 * plugin's parameters show up.
 *
 * This is the definitive proof that an end user can open the
 * eliza UI → Secrets panel → enter `SCAPE_BOT_SDK_TOKEN` and
 * `SCAPE_AGENT_PASSWORD` without touching any shell env var.
 */

import {
    aggregateSecrets,
    discoverPluginsFromManifest,
} from "@elizaos/agent/api/plugin-discovery-helpers";

function assertTrue(label: string, ok: boolean): void {
    if (ok) {
        console.log(`  ✓ ${label}`);
    } else {
        console.log(`  ✗ ${label}`);
        process.exitCode = 1;
    }
}

function main(): void {
    console.log("[verify-pr8-settings] starting");

    // 1. Manifest discovery picks up scape
    console.log("\n[1] discoverPluginsFromManifest() includes scape");
    const allPlugins = discoverPluginsFromManifest();
    const scape = allPlugins.find((p) => p.id === "scape");
    assertTrue("scape entry discovered", scape != null);
    if (!scape) {
        console.log("\n[verify-pr8-settings] FAILED");
        return;
    }
    assertTrue(
        `scape.name = "'scape" (got "${scape.name}")`,
        scape.name === "'scape",
    );
    assertTrue(
        `scape.category = "app" (got "${scape.category}")`,
        scape.category === "app",
    );
    assertTrue(
        `scape.npmName = "@elizaos/app-scape" (got "${scape.npmName}")`,
        scape.npmName === "@elizaos/app-scape",
    );
    assertTrue(
        `scape has 9 parameters (got ${scape.parameters.length})`,
        scape.parameters.length === 9,
    );

    // 2. Each expected parameter key is present
    console.log("\n[2] all 9 parameters are surfaced");
    const paramKeys = new Set(scape.parameters.map((p) => p.key));
    const expectedKeys = [
        "SCAPE_BOT_SDK_TOKEN",
        "SCAPE_AGENT_PASSWORD",
        "SCAPE_BOT_SDK_URL",
        "SCAPE_CLIENT_URL",
        "SCAPE_AGENT_NAME",
        "SCAPE_AGENT_ID",
        "SCAPE_AGENT_PERSONA",
        "SCAPE_LOOP_INTERVAL_MS",
        "SCAPE_MODEL_SIZE",
    ];
    for (const key of expectedKeys) {
        assertTrue(`parameter ${key} present`, paramKeys.has(key));
    }

    // 3. Sensitive flags are correct
    console.log("\n[3] sensitive parameters are marked");
    const sensitiveKeys = new Set(
        scape.parameters.filter((p) => p.sensitive).map((p) => p.key),
    );
    assertTrue(
        "SCAPE_BOT_SDK_TOKEN marked sensitive",
        sensitiveKeys.has("SCAPE_BOT_SDK_TOKEN"),
    );
    assertTrue(
        "SCAPE_AGENT_PASSWORD marked sensitive",
        sensitiveKeys.has("SCAPE_AGENT_PASSWORD"),
    );
    assertTrue(
        "SCAPE_BOT_SDK_URL NOT sensitive (not a secret)",
        !sensitiveKeys.has("SCAPE_BOT_SDK_URL"),
    );
    assertTrue(
        "SCAPE_CLIENT_URL NOT sensitive",
        !sensitiveKeys.has("SCAPE_CLIENT_URL"),
    );

    // 4. Required flags
    console.log("\n[4] required flags");
    const requiredKeys = new Set(
        scape.parameters.filter((p) => p.required).map((p) => p.key),
    );
    assertTrue(
        "SCAPE_BOT_SDK_TOKEN is required",
        requiredKeys.has("SCAPE_BOT_SDK_TOKEN"),
    );
    // SCAPE_AGENT_PASSWORD is intentionally optional now — the plugin
    // auto-generates and persists a fresh identity at
    // ~/.eliza/scape-agent-identity.json on first launch. This field
    // only needs to be set when pinning to a pre-existing account, and
    // agent-identity.ts logs a loud WARN if the operator sets it (the
    // value lands on disk in plaintext). Per the PR body: "The
    // parameter is no longer `required: true`".
    assertTrue(
        "SCAPE_AGENT_PASSWORD is optional (auto-generated when unset)",
        !requiredKeys.has("SCAPE_AGENT_PASSWORD"),
    );
    assertTrue(
        "SCAPE_CLIENT_URL is NOT required",
        !requiredKeys.has("SCAPE_CLIENT_URL"),
    );

    // 5. aggregateSecrets (the exact function GET /api/secrets calls)
    //    picks up the sensitive parameters
    console.log("\n[5] aggregateSecrets surfaces scape secrets for the UI");
    const secrets = aggregateSecrets(allPlugins);
    const scapeSecrets = secrets.filter((s) =>
        s.usedBy.some((u) => u.pluginId === "scape"),
    );
    assertTrue(
        `aggregateSecrets returned ≥2 scape secrets (got ${scapeSecrets.length})`,
        scapeSecrets.length >= 2,
    );
    assertTrue(
        "SCAPE_BOT_SDK_TOKEN is in the secrets list",
        secrets.some((s) => s.key === "SCAPE_BOT_SDK_TOKEN"),
    );
    assertTrue(
        "SCAPE_AGENT_PASSWORD is in the secrets list",
        secrets.some((s) => s.key === "SCAPE_AGENT_PASSWORD"),
    );
    assertTrue(
        "SCAPE_BOT_SDK_URL NOT in secrets (non-sensitive)",
        !secrets.some((s) => s.key === "SCAPE_BOT_SDK_URL"),
    );

    // 6. Default values round-trip
    console.log("\n[6] defaults are preserved");
    const urlParam = scape.parameters.find((p) => p.key === "SCAPE_BOT_SDK_URL");
    assertTrue(
        `SCAPE_BOT_SDK_URL default = "wss://scape-96cxt.sevalla.app/botsdk" (got "${urlParam?.default}")`,
        urlParam?.default === "wss://scape-96cxt.sevalla.app/botsdk",
    );
    const clientParam = scape.parameters.find((p) => p.key === "SCAPE_CLIENT_URL");
    assertTrue(
        `SCAPE_CLIENT_URL default = "https://scape-client-2sqyc.kinsta.page" (got "${clientParam?.default}")`,
        clientParam?.default === "https://scape-client-2sqyc.kinsta.page",
    );
    const loopParam = scape.parameters.find((p) => p.key === "SCAPE_LOOP_INTERVAL_MS");
    assertTrue(
        `SCAPE_LOOP_INTERVAL_MS default = "15000" (got "${loopParam?.default}")`,
        loopParam?.default === "15000",
    );

    if (process.exitCode === 1) {
        console.log("\n[verify-pr8-settings] FAILED");
    } else {
        console.log("\n[verify-pr8-settings] PASSED");
    }
}

main();
