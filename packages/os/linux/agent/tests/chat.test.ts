// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chat } from "../src/chat.ts";

/**
 * These tests pin `USBELIZA_OLLAMA_URL` at an unreachable port so the chat
 * handler's fallthrough path takes the "I can't reach my local model"
 * branch deterministically — independent of whether the dev box has Ollama
 * running. The Ollama-up path is exercised by the live-service smoke test
 * in `vm/scripts/run-tests.sh` (milestone 11d).
 *
 * The network-intent path overrides $USBELIZA_NMCLI to point at fake
 * scripts under temp dirs, so the wifi-list / wifi-connect / network-status
 * branches return deterministic replies without touching the host's real
 * NetworkManager.
 */

const ORIGINAL_URL = Bun.env.USBELIZA_OLLAMA_URL;
const ORIGINAL_ENDPOINT = Bun.env.OLLAMA_API_ENDPOINT;
const ORIGINAL_STATE_DIR = process.env.USBELIZA_STATE_DIR;
let stateDir = "";

beforeAll(() => {
    // Point legacy ollama env vars at a black-hole port (kept for the
    // network-intent tests' nmcli stubs that still reference them) and
    // point the new local-llama-plugin at a non-existent GGUF — so the
    // chat-fallthrough path errors fast with a "GGUF not found" instead
    // of trying to load 770MB of llama.cpp from disk inside the test.
    Bun.env.USBELIZA_OLLAMA_URL = "http://127.0.0.1:1";
    Bun.env.OLLAMA_API_ENDPOINT = "http://127.0.0.1:1/api";
    Bun.env.USBELIZA_GGUF = "/nonexistent/usbeliza-test.gguf";
    Bun.env.LOCAL_LARGE_MODEL = "/nonexistent/usbeliza-test.gguf";
});

afterAll(() => {
    if (ORIGINAL_URL === undefined) {
        delete Bun.env.USBELIZA_OLLAMA_URL;
    } else {
        Bun.env.USBELIZA_OLLAMA_URL = ORIGINAL_URL;
    }
    if (ORIGINAL_ENDPOINT === undefined) {
        delete Bun.env.OLLAMA_API_ENDPOINT;
    } else {
        Bun.env.OLLAMA_API_ENDPOINT = ORIGINAL_ENDPOINT;
    }
    delete Bun.env.USBELIZA_GGUF;
    delete Bun.env.LOCAL_LARGE_MODEL;
    if (ORIGINAL_STATE_DIR === undefined) {
        delete process.env.USBELIZA_STATE_DIR;
    } else {
        process.env.USBELIZA_STATE_DIR = ORIGINAL_STATE_DIR;
    }
});

beforeEach(() => {
    // Onboarding takes precedence over intent dispatch on every chat()
    // call, so each test gets its own state dir with calibration.toml
    // pre-written. The tests for the network/Ollama paths assume normal
    // chat — onboarding-specific behavior is tested in
    // tests/onboarding/dispatcher.test.ts.
    stateDir = mkdtempSync(join(tmpdir(), "usbeliza-chat-state-"));
    process.env.USBELIZA_STATE_DIR = stateDir;
    writeFileSync(
        join(stateDir, "calibration.toml"),
        [
            'schema_version = 1',
            'created_at = "2026-05-11T00:00:00Z"',
            'name = "Test"',
            'work_focus = "testing"',
            'multitasking = "single-task"',
            'chronotype = "flexible"',
            'error_communication = "transparent"',
        ].join("\n"),
    );
});

afterEach(() => {
    if (stateDir !== "") rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
});

const tempDirs: string[] = [];
const originalNmcli = process.env.USBELIZA_NMCLI;
afterEach(() => {
    while (tempDirs.length > 0) {
        const d = tempDirs.pop();
        if (d !== undefined) rmSync(d, { recursive: true, force: true });
    }
    if (originalNmcli !== undefined) {
        process.env.USBELIZA_NMCLI = originalNmcli;
    } else {
        delete process.env.USBELIZA_NMCLI;
    }
});

function fakeNmcli(body: string): void {
    const dir = mkdtempSync(join(tmpdir(), "usbeliza-chat-nmcli-"));
    tempDirs.push(dir);
    const path = join(dir, "nmcli");
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
    process.env.USBELIZA_NMCLI = path;
}

describe("chat handler — fallthrough without Ollama", () => {
    test("returns schema_version=1 + guidance reply when Ollama is unreachable", async () => {
        const response = await chat({ message: "hello" });
        expect(response.schema_version).toBe(1);
        expect(response.reply.length).toBeGreaterThan(0);
        // The real @elizaos/plugin-ollama returns "error generating text..."
        // on connection failure rather than throwing; both the plugin's
        // string and our dispatch's catch path are user-visible errors.
        const lower = response.reply.toLowerCase();
        expect(
            lower.includes("local model") || lower.includes("error") || lower.includes("ollama"),
        ).toBe(true);
    });

    test("does not invoke codegen for non-build messages", async () => {
        const response = await chat({ message: "hi" });
        expect(response.launch).toBeUndefined();
    });
});

describe("chat handler — network intents", () => {
    test("'list wifi' returns formatted SSID list when networks visible", async () => {
        fakeNmcli(`
case "$*" in
  *"--version"*) exit 0 ;;
  *"wifi rescan"*) exit 0 ;;
  *"wifi list"*)
    echo '*:HomeNet:78:WPA2'
    echo ' :Cafe:50:'
    ;;
esac
`);
        const response = await chat({ message: "list wifi networks" });
        expect(response.schema_version).toBe(1);
        expect(response.reply).toContain("HomeNet");
        expect(response.reply).toContain("78%");
        expect(response.reply).toContain("connect to wifi");
    });

    test("'list wifi' gracefully says 'no networks' when empty", async () => {
        fakeNmcli(`
case "$*" in
  *"--version"*) exit 0 ;;
  *"wifi rescan"*) exit 0 ;;
  *"wifi list"*) : ;;
esac
`);
        const response = await chat({ message: "list wifi" });
        expect(response.reply.toLowerCase()).toContain("no wi-fi");
    });

    test("'connect to wifi' with auth error returns helpful reply", async () => {
        fakeNmcli(`
case "$*" in
  *"--version"*) exit 0 ;;
  *)
    echo 'no secrets provided' >&2; exit 4 ;;
esac
`);
        const response = await chat({ message: "connect to wifi MyNet password wrong" });
        expect(response.reply).toContain("Wrong password");
    });

    test("'am i online' reports offline when nmcli says no", async () => {
        fakeNmcli(`
case "$*" in
  *"--version"*) exit 0 ;;
  *"connection show --active"*)
    echo 'Wired:802-3-ethernet:eth0:activated' ;;
  *"device show"*)
    echo '' ;;
esac
`);
        const response = await chat({ message: "am i online" });
        expect(response.reply.toLowerCase()).toContain("offline");
    });

    test("chat falls through to Ollama when nmcli is missing (no network intent fires)", async () => {
        process.env.USBELIZA_NMCLI = "/nonexistent/nmcli";
        const response = await chat({ message: "hi there" });
        // chat fallthrough → real plugin-ollama useModel → connection failure
        // → either our dispatch catch ("local model") or plugin-ollama's
        // own "error generating text..." string. Both are user-facing
        // failure replies; either is acceptable.
        const lower = response.reply.toLowerCase();
        expect(
            lower.includes("local model") || lower.includes("error") || lower.includes("ollama"),
        ).toBe(true);
    });
});
