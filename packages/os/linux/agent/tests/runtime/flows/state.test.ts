// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    clearFlow,
    flowStatePath,
    getFlowState,
    isBailOut,
    setFlow,
    type FlowState,
} from "../../../src/runtime/flows/state.ts";

let tempDir = "";
const originalStateDir = process.env.USBELIZA_STATE_DIR;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "usbeliza-flowstate-"));
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

describe("flow state — set/get/clear", () => {
    test("getFlowState returns null when no file exists", () => {
        expect(getFlowState()).toBeNull();
    });

    test("setFlow + getFlowState round-trips a wifi-setup state", () => {
        const state: FlowState = {
            schema_version: 1,
            flowId: "wifi-setup",
            step: "awaiting-password",
            data: {
                ssid: "ElizaNet",
                attempts: 1,
                networks: ["ElizaNet", "CoffeeShop"],
            },
            updatedAt: Date.now(),
        };
        setFlow(state);
        const loaded = getFlowState();
        expect(loaded).not.toBeNull();
        expect(loaded?.flowId).toBe("wifi-setup");
        expect(loaded?.step).toBe("awaiting-password");
        expect(loaded?.data.ssid).toBe("ElizaNet");
        expect(loaded?.data.attempts).toBe(1);
        expect(loaded?.data.networks).toEqual(["ElizaNet", "CoffeeShop"]);
    });

    test("setFlow persists to ~/.eliza/flow.toml", () => {
        setFlow({
            schema_version: 1,
            flowId: "persistence-setup",
            step: "awaiting-passphrase",
            data: {},
            updatedAt: Date.now(),
        });
        expect(existsSync(flowStatePath())).toBe(true);
    });

    test("clearFlow removes the file", () => {
        setFlow({
            schema_version: 1,
            flowId: "wifi-setup",
            step: "awaiting-ssid",
            data: {},
            updatedAt: Date.now(),
        });
        expect(existsSync(flowStatePath())).toBe(true);
        clearFlow();
        expect(existsSync(flowStatePath())).toBe(false);
        expect(getFlowState()).toBeNull();
    });

    test("clearFlow on a missing file is a no-op", () => {
        expect(() => clearFlow()).not.toThrow();
    });

    test("stale flow (>30min old) is silently cleared", () => {
        setFlow({
            schema_version: 1,
            flowId: "wifi-setup",
            step: "awaiting-ssid",
            data: { networks: ["A", "B"] },
            updatedAt: Date.now() - 60 * 60 * 1000, // 1h ago
        });
        const loaded = getFlowState();
        expect(loaded).toBeNull();
        expect(existsSync(flowStatePath())).toBe(false);
    });

    test("rejects unknown flow_id (corrupted file)", () => {
        setFlow({
            schema_version: 1,
            flowId: "wifi-setup",
            step: "x",
            data: {},
            updatedAt: Date.now(),
        });
        // Tamper: overwrite with a bogus flow_id
        const fs = require("node:fs");
        fs.writeFileSync(
            flowStatePath(),
            `schema_version = 1\nflow_id = "garbage"\nstep = "x"\nupdated_at = ${Date.now()}\n\n[data]\n`,
        );
        expect(getFlowState()).toBeNull();
    });
});

describe("isBailOut", () => {
    test("recognizes the standard bail words", () => {
        expect(isBailOut("cancel")).toBe(true);
        expect(isBailOut("CANCEL")).toBe(true);
        expect(isBailOut("never mind")).toBe(true);
        expect(isBailOut("nevermind")).toBe(true);
        expect(isBailOut("stop")).toBe(true);
        expect(isBailOut("skip")).toBe(true);
        expect(isBailOut("quit")).toBe(true);
        expect(isBailOut("abort")).toBe(true);
    });

    test("ignores substrings inside normal sentences", () => {
        // The user shouldn't trigger a bail by mentioning "cancel" mid-flow.
        expect(isBailOut("the password is cancel123")).toBe(false);
        expect(isBailOut("a sentence containing stop within it")).toBe(false);
    });

    test("empty string is not a bail-out", () => {
        expect(isBailOut("")).toBe(false);
        expect(isBailOut("   ")).toBe(false);
    });

    test("bail word followed by period or space counts", () => {
        expect(isBailOut("cancel.")).toBe(true);
        expect(isBailOut("stop please")).toBe(true);
    });
});
