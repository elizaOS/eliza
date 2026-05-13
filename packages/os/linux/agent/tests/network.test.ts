// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    NetworkError,
    connectWifi,
    isNmcliAvailable,
    listWifi,
    networkStatus,
} from "../src/network.ts";

/**
 * The network module shells out to `nmcli`. To exercise both happy
 * paths and error shapes without depending on the host's actual
 * NetworkManager, we override USBELIZA_NMCLI to point at a fake
 * script we write per-test under a temp dir.
 *
 * Each fake is a single-shot bash script that examines its argv and
 * either prints canned nmcli output or exits with a chosen status.
 */

const originalNmcli = process.env.USBELIZA_NMCLI;
const tempDirs: string[] = [];

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

function fakeNmcli(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "usbeliza-nmcli-"));
    tempDirs.push(dir);
    const path = join(dir, "nmcli");
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
    process.env.USBELIZA_NMCLI = path;
    return path;
}

describe("isNmcliAvailable", () => {
    test("returns true when nmcli runs", async () => {
        fakeNmcli("exit 0");
        expect(await isNmcliAvailable()).toBe(true);
    });

    test("returns false when nmcli is missing", async () => {
        process.env.USBELIZA_NMCLI = "/nonexistent/nmcli-please-fail";
        expect(await isNmcliAvailable()).toBe(false);
    });
});

describe("listWifi", () => {
    test("parses standard nmcli -t output", async () => {
        // Two networks: one active WPA2, one open. Rescan returns 0.
        fakeNmcli(`
case "$*" in
  *"wifi rescan"*) exit 0 ;;
  *"wifi list"*)
    echo '*:HomeNet:78:WPA2'
    echo ' :CoffeeShop:42:'
    echo ' :MyNeighbor:55:WPA2'
    ;;
esac
`);
        const networks = await listWifi();
        expect(networks).toHaveLength(3);
        expect(networks[0]).toEqual({ inUse: true, ssid: "HomeNet", signal: 78, security: "WPA2" });
        // Sorted by signal desc: HomeNet(78), MyNeighbor(55), CoffeeShop(42)
        expect(networks[1]?.ssid).toBe("MyNeighbor");
        expect(networks[2]?.ssid).toBe("CoffeeShop");
    });

    test("filters out blank SSIDs", async () => {
        fakeNmcli(`
case "$*" in
  *"wifi rescan"*) exit 0 ;;
  *"wifi list"*) echo ' ::20:'; echo ' :OnlyOne:99:' ;;
esac
`);
        const networks = await listWifi();
        expect(networks).toHaveLength(1);
        expect(networks[0]?.ssid).toBe("OnlyOne");
    });

    test("handles rescan failure gracefully (still returns list)", async () => {
        fakeNmcli(`
case "$*" in
  *"wifi rescan"*) echo "scan in progress" >&2; exit 1 ;;
  *"wifi list"*) echo ' :Cafe:60:WPA2' ;;
esac
`);
        const networks = await listWifi();
        expect(networks).toHaveLength(1);
        expect(networks[0]?.ssid).toBe("Cafe");
    });
});

describe("connectWifi", () => {
    test("passes password when provided", async () => {
        fakeNmcli(`
# Echo argv so the test can verify what we got called with.
echo "$@"
`);
        const out = await connectWifi("MyNet", "hunter2");
        expect(out).toContain("MyNet");
        expect(out).toContain("hunter2");
    });

    test("omits password argv when not provided", async () => {
        fakeNmcli(`echo "$@"`);
        const out = await connectWifi("MyNet");
        expect(out).toContain("MyNet");
        expect(out).not.toContain("password");
    });

    test("maps 'no secrets' nmcli failure to auth NetworkError", async () => {
        fakeNmcli(`echo "no secrets provided" >&2; exit 4`);
        let caught: unknown;
        try {
            await connectWifi("MyNet", "wrong");
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(NetworkError);
        expect((caught as NetworkError).code).toBe("auth");
    });

    test("maps daemon-down failure to no-daemon code", async () => {
        fakeNmcli(`echo "Error: NetworkManager is not running" >&2; exit 8`);
        let caught: unknown;
        try {
            await connectWifi("MyNet");
        } catch (e) {
            caught = e;
        }
        expect((caught as NetworkError).code).toBe("no-daemon");
    });
});

describe("networkStatus", () => {
    test("returns offline when no active wifi connection", async () => {
        fakeNmcli(`
case "$*" in
  *"connection show --active"*)
    # Only lo / wired listed, no wifi
    echo 'Wired connection 1:802-3-ethernet:eth0:activated' ;;
  *"device show"*)
    echo '' ;;
esac
`);
        const status = await networkStatus();
        expect(status.activeSsid).toBeNull();
        expect(status.online).toBe(false);
    });

    test("returns online with SSID + IP when wifi is up", async () => {
        fakeNmcli(`
case "$*" in
  *"connection show --active"*)
    echo 'HomeNet:802-11-wireless:wlan0:activated' ;;
  *"device show"*)
    echo 'GENERAL.DEVICE:wlan0'
    echo 'IP4.ADDRESS[1]:192.168.1.42/24' ;;
esac
`);
        const status = await networkStatus();
        expect(status.activeSsid).toBe("HomeNet");
        expect(status.ipv4).toBe("192.168.1.42");
        expect(status.online).toBe(true);
    });
});
