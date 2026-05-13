// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NetworkError, type NetworkStatus } from "../../../src/network.ts";
import {
    beginWifiFlow,
    continueWifiFlow,
    describeNetworks,
    matchSsidReply,
    shouldStartWifiFlow,
    type WifiDeps,
    type WifiNetwork,
} from "../../../src/runtime/flows/wifi-flow.ts";
import { clearFlow, getFlowState } from "../../../src/runtime/flows/state.ts";

let tempDir = "";
const originalStateDir = process.env.USBELIZA_STATE_DIR;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "usbeliza-wifi-flow-"));
    process.env.USBELIZA_STATE_DIR = tempDir;
});

afterEach(() => {
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
    if (originalStateDir !== undefined) {
        process.env.USBELIZA_STATE_DIR = originalStateDir;
    } else {
        delete process.env.USBELIZA_STATE_DIR;
    }
});

/** Build a deps object with stubbed boundaries — defaults to success paths. */
function makeDeps(overrides: Partial<WifiDeps> = {}): WifiDeps {
    return {
        listWifi: overrides.listWifi ?? (async () => [] as WifiNetwork[]),
        connectWifi: overrides.connectWifi ?? (async () => "ok"),
        networkStatus:
            overrides.networkStatus ??
            (async (): Promise<NetworkStatus> => ({
                online: true,
                activeSsid: null,
                ipv4: "10.0.0.5",
            })),
    };
}

describe("shouldStartWifiFlow", () => {
    test("triggers on 'connect to wifi' alone", () => {
        expect(shouldStartWifiFlow("connect to wifi")).toBe(true);
        expect(shouldStartWifiFlow("CONNECT TO WIFI")).toBe(true);
    });

    test("triggers on 'get me online'", () => {
        expect(shouldStartWifiFlow("get me online")).toBe(true);
        expect(shouldStartWifiFlow("can you get me online please")).toBe(true);
    });

    test("does NOT trigger when SSID is supplied inline", () => {
        expect(shouldStartWifiFlow("connect to wifi MyHome")).toBe(false);
        expect(shouldStartWifiFlow("connect to wifi MyHome password hunter2")).toBe(false);
    });

    test("does NOT trigger on unrelated chat", () => {
        expect(shouldStartWifiFlow("what's the weather")).toBe(false);
        expect(shouldStartWifiFlow("")).toBe(false);
    });

    test("triggers with conversational fillers (please, now)", () => {
        expect(shouldStartWifiFlow("connect to wifi please")).toBe(true);
        expect(shouldStartWifiFlow("connect to wifi for me now")).toBe(true);
    });
});

describe("matchSsidReply", () => {
    const ssids = ["ElizaNet", "CoffeeShop-Guest", "5G-Home"];

    test("exact match wins", () => {
        expect(matchSsidReply("ElizaNet", ssids)).toBe("ElizaNet");
        expect(matchSsidReply("elizanet", ssids)).toBe("ElizaNet");
    });

    test("unique prefix wins", () => {
        expect(matchSsidReply("eliza", ssids)).toBe("ElizaNet");
        expect(matchSsidReply("coffee", ssids)).toBe("CoffeeShop-Guest");
    });

    test("unique substring wins", () => {
        expect(matchSsidReply("guest", ssids)).toBe("CoffeeShop-Guest");
        expect(matchSsidReply("home", ssids)).toBe("5G-Home");
    });

    test("ambiguous matches return null", () => {
        const dup = ["MyNet", "MyNet-Guest", "MyOther"];
        // "my" matches all three by prefix → ambiguous.
        expect(matchSsidReply("my", dup)).toBeNull();
    });

    test("no match returns null", () => {
        expect(matchSsidReply("nonsense", ssids)).toBeNull();
        expect(matchSsidReply("", ssids)).toBeNull();
    });
});

describe("describeNetworks", () => {
    test("zero networks → 'nothing in range'", () => {
        const out = describeNetworks([]);
        expect(out.toLowerCase()).toContain("don't see any wifi");
    });

    test("one network mentions name + open/protected", () => {
        const out = describeNetworks([
            { ssid: "Solo", signal: 80, security: "WPA2", inUse: false },
        ]);
        expect(out).toContain("Solo");
        expect(out.toLowerCase()).toContain("password-protected");
    });

    test("two networks names the top two in prose, not a bullet list", () => {
        const out = describeNetworks([
            { ssid: "Alpha", signal: 90, security: "WPA2", inUse: false },
            { ssid: "Beta", signal: 60, security: "WPA2", inUse: false },
        ]);
        expect(out).toContain("Alpha");
        expect(out).toContain("Beta");
        expect(out.toLowerCase()).toContain("strongest signal");
        // No markdown bullets allowed in the chat surface.
        expect(out.split("\n").some((l) => l.trim().startsWith("- "))).toBe(false);
    });

    test("three networks names all three", () => {
        const out = describeNetworks([
            { ssid: "Alpha", signal: 90, security: "WPA2", inUse: false },
            { ssid: "Beta", signal: 60, security: "WPA2", inUse: false },
            { ssid: "Gamma", signal: 40, security: "", inUse: false },
        ]);
        expect(out).toContain("Alpha");
        expect(out).toContain("Beta");
        expect(out).toContain("Gamma");
    });

    test("four+ networks names the top three with count", () => {
        const out = describeNetworks([
            { ssid: "A", signal: 99, security: "WPA2", inUse: false },
            { ssid: "B", signal: 80, security: "WPA2", inUse: false },
            { ssid: "C", signal: 70, security: "WPA2", inUse: false },
            { ssid: "D", signal: 60, security: "", inUse: false },
        ]);
        expect(out).toContain("4 network");
        expect(out).toContain("A");
        expect(out).toContain("B");
        expect(out).toContain("C");
    });
});

describe("wifi flow — beginWifiFlow", () => {
    test("listWifi success seeds the flow + asks user to pick", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "ElizaNet", signal: 90, security: "WPA2", inUse: false },
                { ssid: "CoffeeShop", signal: 60, security: "", inUse: false },
            ],
        });
        const out = await beginWifiFlow(deps);
        expect(out.done).toBe(false);
        expect(out.reply).toContain("ElizaNet");
        expect(out.reply).toContain("CoffeeShop");
        const flow = getFlowState();
        expect(flow).not.toBeNull();
        expect(flow?.flowId).toBe("wifi-setup");
        expect(flow?.step).toBe("awaiting-ssid");
        expect(flow?.data.networks).toEqual(["ElizaNet", "CoffeeShop"]);
    });

    test("empty network list ends the flow without persisting state", async () => {
        const deps = makeDeps({ listWifi: async () => [] });
        const out = await beginWifiFlow(deps);
        expect(out.done).toBe(true);
        expect(getFlowState()).toBeNull();
    });

    test("no-nmcli error reports the friendly message + ends flow", async () => {
        const deps = makeDeps({
            listWifi: async () => {
                throw new NetworkError("missing", "no-nmcli");
            },
        });
        const out = await beginWifiFlow(deps);
        expect(out.done).toBe(true);
        expect(out.reply.toLowerCase()).toContain("nmcli isn't on this system");
        expect(getFlowState()).toBeNull();
    });

    test("rfkill error gives the toggle-hardware-switch hint", async () => {
        const deps = makeDeps({
            listWifi: async () => {
                throw new NetworkError("blocked", "rfkill");
            },
        });
        const out = await beginWifiFlow(deps);
        expect(out.done).toBe(true);
        expect(out.reply.toLowerCase()).toContain("hardware-blocked");
    });
});

describe("wifi flow — continueWifiFlow (awaiting-ssid)", () => {
    test("open network → connects immediately + reports IP", async () => {
        const captured: Array<{ ssid: string; password?: string }> = [];
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "OpenCafe", signal: 70, security: "", inUse: false },
            ],
            connectWifi: async (ssid, password) => {
                captured.push({ ssid, ...(password !== undefined ? { password } : {}) });
                return "ok";
            },
        });
        await beginWifiFlow(deps);
        const flow = getFlowState();
        expect(flow).not.toBeNull();
        const out = await continueWifiFlow("OpenCafe", flow!, deps);
        expect(out.done).toBe(true);
        expect(out.reply).toContain("Connected to OpenCafe");
        expect(out.reply).toContain("10.0.0.5");
        expect(captured).toHaveLength(1);
        expect(captured[0]).toEqual({ ssid: "OpenCafe" });
        expect(getFlowState()).toBeNull();
    });

    test("WPA network → asks for password, sets awaiting-password", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "Locked", signal: 80, security: "WPA2", inUse: false },
            ],
        });
        await beginWifiFlow(deps);
        const flow = getFlowState();
        expect(flow).not.toBeNull();
        const out = await continueWifiFlow("Locked", flow!, deps);
        expect(out.done).toBe(false);
        expect(out.reply.toLowerCase()).toContain("password");
        const newState = getFlowState();
        expect(newState?.step).toBe("awaiting-password");
        expect(newState?.data.ssid).toBe("Locked");
    });

    test("ambiguous SSID reply gently re-asks without ending the flow", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "MyNet", signal: 80, security: "WPA2", inUse: false },
                { ssid: "MyNet-Guest", signal: 60, security: "WPA2", inUse: false },
            ],
        });
        await beginWifiFlow(deps);
        const flow = getFlowState();
        const out = await continueWifiFlow("my", flow!, deps);
        expect(out.done).toBe(false);
        expect(out.reply.toLowerCase()).toContain("not sure which one");
        expect(getFlowState()?.step).toBe("awaiting-ssid");
    });
});

describe("wifi flow — continueWifiFlow (awaiting-password)", () => {
    test("correct password connects + clears flow", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "Home", signal: 90, security: "WPA2", inUse: false },
            ],
            connectWifi: async () => "ok",
        });
        await beginWifiFlow(deps);
        await continueWifiFlow("Home", getFlowState()!, deps);
        const flow = getFlowState();
        expect(flow?.step).toBe("awaiting-password");
        const out = await continueWifiFlow("hunter2", flow!, deps);
        expect(out.done).toBe(true);
        expect(out.reply).toContain("Connected to Home");
        expect(getFlowState()).toBeNull();
    });

    test("wrong password sets awaiting-password-retry + asks to retry", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "Home", signal: 90, security: "WPA2", inUse: false },
            ],
            connectWifi: async () => {
                throw new NetworkError("auth", "auth");
            },
        });
        await beginWifiFlow(deps);
        await continueWifiFlow("Home", getFlowState()!, deps);
        const out = await continueWifiFlow("wrongpass", getFlowState()!, deps);
        expect(out.done).toBe(false);
        expect(out.reply.toLowerCase()).toContain("wrong password");
        expect(getFlowState()?.step).toBe("awaiting-password-retry");
        expect(getFlowState()?.data.attempts).toBe(1);
    });

    test("3 wrong passwords ends the flow with a 'three tries' message", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "Home", signal: 90, security: "WPA2", inUse: false },
            ],
            connectWifi: async () => {
                throw new NetworkError("auth", "auth");
            },
        });
        await beginWifiFlow(deps);
        await continueWifiFlow("Home", getFlowState()!, deps);
        await continueWifiFlow("try1", getFlowState()!, deps); // attempts=1
        await continueWifiFlow("try2", getFlowState()!, deps); // attempts=2
        const out = await continueWifiFlow("try3", getFlowState()!, deps); // attempts=3
        expect(out.done).toBe(true);
        expect(out.reply.toLowerCase()).toContain("three tries");
        expect(getFlowState()).toBeNull();
    });

    test("'pick a different network' on retry restarts the listing", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "Home", signal: 90, security: "WPA2", inUse: false },
                { ssid: "Other", signal: 60, security: "WPA2", inUse: false },
            ],
            connectWifi: async () => {
                throw new NetworkError("auth", "auth");
            },
        });
        await beginWifiFlow(deps);
        await continueWifiFlow("Home", getFlowState()!, deps);
        await continueWifiFlow("wrong", getFlowState()!, deps); // → retry state
        const out = await continueWifiFlow(
            "pick a different network",
            getFlowState()!,
            deps,
        );
        expect(out.done).toBe(false);
        expect(out.reply).toContain("Home");
        expect(out.reply).toContain("Other");
        expect(getFlowState()?.step).toBe("awaiting-ssid");
    });

    test("non-auth connect error ends the flow with the error message", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "Home", signal: 90, security: "WPA2", inUse: false },
            ],
            connectWifi: async () => {
                throw new NetworkError("daemon dead", "no-daemon");
            },
        });
        await beginWifiFlow(deps);
        await continueWifiFlow("Home", getFlowState()!, deps);
        const out = await continueWifiFlow("hunter2", getFlowState()!, deps);
        expect(out.done).toBe(true);
        expect(out.reply.toLowerCase()).toContain("couldn't connect");
        expect(getFlowState()).toBeNull();
    });
});

describe("wifi flow — chat reply hygiene", () => {
    test("no markdown bullets in any reply", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "A", signal: 90, security: "WPA2", inUse: false },
                { ssid: "B", signal: 60, security: "", inUse: false },
                { ssid: "C", signal: 40, security: "WPA2", inUse: false },
            ],
        });
        const out1 = await beginWifiFlow(deps);
        expect(out1.reply.split("\n").some((l) => l.trim().startsWith("- "))).toBe(false);
        expect(out1.reply.split("\n").some((l) => l.trim().startsWith("* "))).toBe(false);
        const out2 = await continueWifiFlow("A", getFlowState()!, deps);
        expect(out2.reply.split("\n").some((l) => l.trim().startsWith("- "))).toBe(false);
    });

    test("replies are 1-3 sentences (≤4 periods)", async () => {
        const deps = makeDeps({
            listWifi: async () => [
                { ssid: "A", signal: 90, security: "WPA2", inUse: false },
            ],
            connectWifi: async () => "ok",
        });
        const out = await beginWifiFlow(deps);
        const sentences = out.reply.match(/[.!?]/g) ?? [];
        expect(sentences.length).toBeLessThanOrEqual(4);
    });

    afterEach(() => {
        clearFlow();
    });
});
