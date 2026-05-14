// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * INSTALL_PACKAGE unit tests.
 *
 * Same shape as download-model.test.ts: mock the apt-cache + spawn
 * boundaries so we never touch a real apt index. The temp state dir
 * isolates flow state writes between tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import {
    DANGEROUS_PACKAGES,
    INSTALL_PACKAGE_ACTION,
    PACKAGE_NAME_RE,
    extractPackages,
    hasInstallIntent,
    isDangerous,
} from "../src/runtime/actions/install-package.ts";
import {
    _resetInstallRegistry,
    beginInstallPackageFlow,
    continueInstallPackageFlow,
    formatConfirmPrompt,
    formatDuration,
} from "../src/runtime/flows/install-package-flow.ts";
import {
    parseAptCacheShow,
    type AptCacheFn,
    type SpawnStream,
    type SpawnStreamFn,
} from "../src/runtime/flows/install-package-runner.ts";
import { matchAction } from "../src/runtime/match.ts";
import { USBELIZA_ACTIONS } from "../src/runtime/plugin.ts";
import { clearFlow, getFlowState } from "../src/runtime/flows/state.ts";

const fakeRuntime = {} as unknown as IAgentRuntime;
const memoryOf = (text: string) =>
    ({ content: { text } } as unknown as Memory);

const originalStateDir = process.env.USBELIZA_STATE_DIR;
const originalDangerous = process.env.USBELIZA_ALLOW_DANGEROUS_PACKAGES;

let tempRoot = "";

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "usbeliza-install-"));
    process.env.USBELIZA_STATE_DIR = tempRoot;
    _resetInstallRegistry();
});

afterEach(() => {
    clearFlow();
    _resetInstallRegistry();
    if (tempRoot !== "") {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = "";
    }
    if (originalStateDir === undefined) delete process.env.USBELIZA_STATE_DIR;
    else process.env.USBELIZA_STATE_DIR = originalStateDir;
    if (originalDangerous === undefined) delete process.env.USBELIZA_ALLOW_DANGEROUS_PACKAGES;
    else process.env.USBELIZA_ALLOW_DANGEROUS_PACKAGES = originalDangerous;
});

const goodCache: AptCacheFn = async (pkg) => {
    // Pretend every queried package exists at 5000 KB (~5 MB).
    if (pkg === "missing-pkg") return null;
    return { sizeKb: 5000, version: "1.0" };
};

function buildSpawn(opts: {
    settingUps?: readonly string[];
    stderr?: readonly string[];
    exitCode?: number;
    delayMs?: number;
}): SpawnStreamFn {
    return () => {
        async function* stdout(): AsyncIterable<string> {
            for (const pkg of opts.settingUps ?? []) {
                yield `Setting up ${pkg} (1.0-1) ...`;
            }
        }
        async function* stderr(): AsyncIterable<string> {
            for (const line of opts.stderr ?? []) {
                yield line;
            }
        }
        let killed = false;
        const stream: SpawnStream = {
            stdout: stdout(),
            stderr: stderr(),
            exit: new Promise<number | null>((resolve) => {
                if (opts.delayMs !== undefined) {
                    setTimeout(() => resolve(killed ? 130 : opts.exitCode ?? 0), opts.delayMs);
                } else {
                    resolve(opts.exitCode ?? 0);
                }
            }),
            kill: () => {
                killed = true;
            },
        };
        return stream;
    };
}

describe("PACKAGE_NAME_RE", () => {
    test("accepts standard debian package names", () => {
        expect(PACKAGE_NAME_RE.test("vim")).toBe(true);
        expect(PACKAGE_NAME_RE.test("gnome-shell")).toBe(true);
        expect(PACKAGE_NAME_RE.test("libssl3")).toBe(true);
        expect(PACKAGE_NAME_RE.test("g++-12")).toBe(true);
        expect(PACKAGE_NAME_RE.test("python3.11")).toBe(true);
    });

    test("rejects shell metacharacters + uppercase", () => {
        expect(PACKAGE_NAME_RE.test("rm -rf /")).toBe(false);
        expect(PACKAGE_NAME_RE.test("vim;ls")).toBe(false);
        expect(PACKAGE_NAME_RE.test("Vim")).toBe(false);
        expect(PACKAGE_NAME_RE.test("$pkg")).toBe(false);
        expect(PACKAGE_NAME_RE.test("../etc")).toBe(false);
    });

    test("rejects single-char names (Debian policy requires 2+)", () => {
        expect(PACKAGE_NAME_RE.test("a")).toBe(false);
        expect(PACKAGE_NAME_RE.test("ab")).toBe(true);
    });
});

describe("extractPackages", () => {
    test("single-package extraction", () => {
        const r = extractPackages("install vim");
        expect(r?.packages).toEqual(["vim"]);
        expect(r?.fromGroup).toBe(false);
    });

    test("apt install form", () => {
        const r = extractPackages("apt install ripgrep");
        expect(r?.packages).toEqual(["ripgrep"]);
    });

    test("'give me a minimalist i3 desktop' → curated group", () => {
        const r = extractPackages("give me a minimalist i3 desktop");
        expect(r?.fromGroup).toBe(true);
        expect(r?.packages).toContain("i3");
        expect(r?.packages).toContain("i3status");
        expect(r?.packages).toContain("dmenu");
        expect(r?.packages).toContain("xterm");
    });

    test("multi-package whitespace tail", () => {
        const r = extractPackages("install vim git curl");
        expect(r?.packages).toEqual(["vim", "git", "curl"]);
    });

    test("rejects shell injection", () => {
        // The tail is "; rm -rf /" which contains no valid package name
        // tokens (semicolons / slashes / spaces fail PACKAGE_NAME_RE).
        const r = extractPackages("install ; rm -rf /");
        expect(r).toBeNull();
    });

    test("rejects venting non-package tails", () => {
        expect(extractPackages("install vibes")).toBeNull();
        expect(extractPackages("install confidence")).toBeNull();
    });

    test("'set up vim' form works", () => {
        const r = extractPackages("set up vim");
        expect(r?.packages).toEqual(["vim"]);
    });

    test("trims trailing 'please' / 'for me'", () => {
        const r = extractPackages("install vim please");
        expect(r?.packages).toEqual(["vim"]);
        const r2 = extractPackages("install vim for me");
        expect(r2?.packages).toEqual(["vim"]);
    });

    test("empty / whitespace returns null", () => {
        expect(extractPackages("")).toBeNull();
        expect(extractPackages("   ")).toBeNull();
        expect(extractPackages("hello")).toBeNull();
    });
});

describe("hasInstallIntent", () => {
    test("matches verb + name", () => {
        expect(hasInstallIntent("install vim")).toBe(true);
        expect(hasInstallIntent("apt install ripgrep")).toBe(true);
        expect(hasInstallIntent("set up vim")).toBe(true);
        expect(hasInstallIntent("give me a minimalist i3 desktop")).toBe(true);
    });

    test("rejects unparseable / vent forms", () => {
        expect(hasInstallIntent("install vibes")).toBe(false);
        expect(hasInstallIntent("hello there")).toBe(false);
        expect(hasInstallIntent("")).toBe(false);
    });

    test("validate() agrees with hasInstallIntent", async () => {
        expect(await INSTALL_PACKAGE_ACTION.validate(fakeRuntime, memoryOf("install vim"), undefined)).toBe(true);
        expect(await INSTALL_PACKAGE_ACTION.validate(fakeRuntime, memoryOf("hello"), undefined)).toBe(false);
    });
});

describe("isDangerous / DANGEROUS_PACKAGES", () => {
    test("default blocklist", () => {
        expect(isDangerous("openssh-server")).toBe(true);
        expect(isDangerous("sudo")).toBe(true);
        expect(isDangerous("vim")).toBe(false);
        expect(DANGEROUS_PACKAGES.size).toBeGreaterThan(0);
    });

    test("env override unlocks dangerous installs", () => {
        process.env.USBELIZA_ALLOW_DANGEROUS_PACKAGES = "1";
        expect(isDangerous("openssh-server")).toBe(false);
    });
});

describe("parseAptCacheShow", () => {
    test("extracts Installed-Size and Version", () => {
        const out = [
            "Package: vim",
            "Version: 2:9.0.1378-2",
            "Installed-Size: 3245",
            "Priority: optional",
            "",
        ].join("\n");
        const info = parseAptCacheShow(out);
        expect(info?.sizeKb).toBe(3245);
        expect(info?.version).toBe("2:9.0.1378-2");
    });

    test("returns null when no Installed-Size", () => {
        expect(parseAptCacheShow("Package: vim\nVersion: 1.0\n")).toBeNull();
    });
});

describe("formatConfirmPrompt", () => {
    test("single package", () => {
        expect(formatConfirmPrompt(["vim"], 5)).toContain("install vim");
        expect(formatConfirmPrompt(["vim"], 5)).toContain("yes / no");
    });

    test("multi-package", () => {
        const out = formatConfirmPrompt(["i3", "dmenu", "xterm"], 12);
        expect(out).toContain("i3, dmenu, and xterm");
        expect(out).toContain("~12 MB");
    });
});

describe("formatDuration", () => {
    test("formats seconds and minutes", () => {
        expect(formatDuration(1000)).toBe("1s");
        expect(formatDuration(45000)).toBe("45s");
        expect(formatDuration(75000)).toBe("1m 15s");
        expect(formatDuration(138000)).toBe("2m 18s");
    });
});

describe("INSTALL_PACKAGE handler (confirmation flow entry)", () => {
    test("single-package happy path emits confirm prompt + sets flow state", async () => {
        const captured: string[] = [];
        const result = await INSTALL_PACKAGE_ACTION.handler(
            fakeRuntime,
            memoryOf("install vim"),
            undefined,
            { aptCacheFn: goodCache, spawnFn: buildSpawn({ settingUps: ["vim"] }) },
            async (response) => {
                if (typeof response.text === "string") captured.push(response.text);
                return [];
            },
        );
        expect(result?.success).toBe(true);
        expect(captured.some((t) => t.includes("install vim"))).toBe(true);
        const flow = getFlowState();
        expect(flow?.flowId).toBe("install-package");
        expect(flow?.step).toBe("confirm");
        expect(flow?.data.packages).toEqual(["vim"]);
    });

    test("group-phrase expansion installs all in the group", async () => {
        const captured: string[] = [];
        await INSTALL_PACKAGE_ACTION.handler(
            fakeRuntime,
            memoryOf("give me a minimalist i3 desktop"),
            undefined,
            { aptCacheFn: goodCache, spawnFn: buildSpawn({ settingUps: [] }) },
            async (response) => {
                if (typeof response.text === "string") captured.push(response.text);
                return [];
            },
        );
        const flow = getFlowState();
        expect(flow?.data.packages).toEqual(["i3", "i3status", "i3lock", "dmenu", "xterm"]);
    });

    test("dangerous package is refused without env override", async () => {
        const captured: string[] = [];
        const result = await INSTALL_PACKAGE_ACTION.handler(
            fakeRuntime,
            memoryOf("install openssh-server"),
            undefined,
            { aptCacheFn: goodCache, spawnFn: buildSpawn({}) },
            async (response) => {
                if (typeof response.text === "string") captured.push(response.text);
                return [];
            },
        );
        expect(result?.success).toBe(false);
        expect(captured.some((t) => t.includes("can't install"))).toBe(true);
        expect(getFlowState()).toBeNull();
    });

    test("missing package returns 'I can't find' error", async () => {
        const missingCache: AptCacheFn = async () => null;
        const captured: string[] = [];
        const result = await INSTALL_PACKAGE_ACTION.handler(
            fakeRuntime,
            memoryOf("install missing-pkg"),
            undefined,
            { aptCacheFn: missingCache, spawnFn: buildSpawn({}) },
            async (response) => {
                if (typeof response.text === "string") captured.push(response.text);
                return [];
            },
        );
        expect(result?.success).toBe(false);
        expect(captured.some((t) => t.toLowerCase().includes("can't find"))).toBe(true);
    });

    test("unparseable input bails", async () => {
        const result = await INSTALL_PACKAGE_ACTION.handler(
            fakeRuntime,
            memoryOf("install vibes"),
            undefined,
            { aptCacheFn: goodCache, spawnFn: buildSpawn({}) },
        );
        expect(result?.success).toBe(false);
    });
});

describe("install-package flow (continueInstallPackageFlow)", () => {
    test("yes transitions through confirm → running, runs spawn, reports success", async () => {
        const spawnFn = buildSpawn({ settingUps: ["vim"], exitCode: 0 });
        await beginInstallPackageFlow({ packages: ["vim"], sizeMb: 5, spawnFn });
        const flow0 = getFlowState();
        expect(flow0?.step).toBe("confirm");

        const r = await continueInstallPackageFlow("yes", flow0!);
        expect(r.done).toBe(true);
        expect(r.reply).toMatch(/Installed vim/);
        expect(getFlowState()).toBeNull();
    });

    test("no clears the flow with 'skipped'", async () => {
        await beginInstallPackageFlow({ packages: ["vim"], sizeMb: 5, spawnFn: buildSpawn({}) });
        const flow0 = getFlowState();
        const r = await continueInstallPackageFlow("no", flow0!);
        expect(r.done).toBe(true);
        expect(r.reply.toLowerCase()).toContain("skipped");
        expect(getFlowState()).toBeNull();
    });

    test("ambiguous reply stays in confirm step", async () => {
        await beginInstallPackageFlow({ packages: ["vim"], sizeMb: 5, spawnFn: buildSpawn({}) });
        const flow0 = getFlowState();
        const r = await continueInstallPackageFlow("maybe later", flow0!);
        expect(r.done).toBe(false);
        const flow1 = getFlowState();
        expect(flow1?.step).toBe("confirm");
    });

    test("apt failure surfaces error suffix", async () => {
        const spawnFn = buildSpawn({
            settingUps: [],
            stderr: ["E: Unable to locate package vim"],
            exitCode: 100,
        });
        await beginInstallPackageFlow({ packages: ["vim"], sizeMb: 5, spawnFn });
        const flow0 = getFlowState();
        const r = await continueInstallPackageFlow("yes", flow0!);
        expect(r.done).toBe(true);
        expect(r.reply).toContain("Install failed");
        expect(getFlowState()).toBeNull();
    });

    test("spawn args include sudo apt-get install -y", async () => {
        let capturedCmd = "";
        let capturedArgs: readonly string[] = [];
        const spawnFn: SpawnStreamFn = (cmd, args) => {
            capturedCmd = cmd;
            capturedArgs = args;
            return {
                stdout: (async function* () {
                    yield "Setting up vim (1.0-1) ...";
                })(),
                stderr: (async function* () {})(),
                exit: Promise.resolve(0),
                kill: () => {},
            };
        };
        await beginInstallPackageFlow({ packages: ["vim", "git"], sizeMb: 5, spawnFn });
        const flow0 = getFlowState();
        await continueInstallPackageFlow("yes", flow0!);
        expect(capturedCmd).toBe("sudo");
        expect(capturedArgs).toContain("apt-get");
        expect(capturedArgs).toContain("install");
        expect(capturedArgs).toContain("-y");
        expect(capturedArgs).toContain("vim");
        expect(capturedArgs).toContain("git");
    });

    test("concurrent install attempt is refused", async () => {
        // Start a slow install so the in-flight check trips.
        const slowSpawn = buildSpawn({ settingUps: ["vim"], delayMs: 500 });
        await beginInstallPackageFlow({ packages: ["vim"], sizeMb: 5, spawnFn: slowSpawn });
        const flow0 = getFlowState();
        const replyPromise = continueInstallPackageFlow("yes", flow0!);
        // While that's in flight, try to start another.
        const second = await beginInstallPackageFlow({
            packages: ["git"],
            sizeMb: 5,
            spawnFn: buildSpawn({}),
        });
        expect(second.reply).toMatch(/already running/i);
        // Drain the first install.
        await replyPromise;
    });
});

describe("Action selection (similes)", () => {
    test("'install vim' picks INSTALL_PACKAGE", () => {
        const m = matchAction("install vim", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("INSTALL_PACKAGE");
    });

    test("'apt install ripgrep' picks INSTALL_PACKAGE", () => {
        const m = matchAction("apt install ripgrep", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("INSTALL_PACKAGE");
    });
});
