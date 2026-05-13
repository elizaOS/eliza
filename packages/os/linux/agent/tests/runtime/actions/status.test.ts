// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Unit tests for BATTERY_STATUS + CURRENT_TIME.
 *
 * The handlers touch the filesystem (`/sys/class/power_supply/BAT*`,
 * `~/.eliza/calibration.toml`). Rather than mocking node:fs, we point
 * the actions at a per-test temp tree via the env-var hooks both modules
 * already expose (`USBELIZA_POWER_SUPPLY_ROOT`, `USBELIZA_CALIBRATION_FILE`).
 * That keeps the production code path identical between test and prod.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

import {
    BATTERY_STATUS_ACTION,
    CURRENT_TIME_ACTION,
    formatBatteryReply,
    formatTimeReply,
    readBattery,
    readCalibrationTimezone,
} from "../../../src/runtime/actions/status.ts";

const fakeRuntime = {} as unknown as IAgentRuntime;
const fakeState = {} as unknown as State;
const memoryOf = (text: string): Memory => ({ content: { text } } as unknown as Memory);

const originalPowerRoot = process.env.USBELIZA_POWER_SUPPLY_ROOT;
const originalCalibrationFile = process.env.USBELIZA_CALIBRATION_FILE;
const originalStateDir = process.env.USBELIZA_STATE_DIR;

let tempRoot = "";

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "usbeliza-status-"));
    process.env.USBELIZA_POWER_SUPPLY_ROOT = join(tempRoot, "power_supply");
    process.env.USBELIZA_CALIBRATION_FILE = join(tempRoot, "calibration.toml");
    delete process.env.USBELIZA_STATE_DIR;
});

afterEach(() => {
    if (tempRoot !== "") {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = "";
    }
    if (originalPowerRoot === undefined) delete process.env.USBELIZA_POWER_SUPPLY_ROOT;
    else process.env.USBELIZA_POWER_SUPPLY_ROOT = originalPowerRoot;
    if (originalCalibrationFile === undefined) delete process.env.USBELIZA_CALIBRATION_FILE;
    else process.env.USBELIZA_CALIBRATION_FILE = originalCalibrationFile;
    if (originalStateDir === undefined) delete process.env.USBELIZA_STATE_DIR;
    else process.env.USBELIZA_STATE_DIR = originalStateDir;
});

function writeBatteryFixture(values: Record<string, string>): void {
    const dir = join(tempRoot, "power_supply", "BAT0");
    mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(values)) {
        writeFileSync(join(dir, k), v);
    }
}

describe("readBattery", () => {
    test("returns null when no BAT* directory exists", async () => {
        // power_supply root doesn't even exist — no battery
        const reading = await readBattery();
        expect(reading).toBeNull();
    });

    test("returns null when power_supply exists but only AC adapters", async () => {
        const ac = join(tempRoot, "power_supply", "AC");
        mkdirSync(ac, { recursive: true });
        writeFileSync(join(ac, "online"), "1\n");
        const reading = await readBattery();
        expect(reading).toBeNull();
    });

    test("reads capacity + status from BAT0", async () => {
        writeBatteryFixture({ capacity: "78\n", status: "Charging\n" });
        const reading = await readBattery();
        expect(reading).not.toBeNull();
        expect(reading?.capacity).toBe(78);
        expect(reading?.status).toBe("Charging");
        // Not discharging — no runtime estimate
        expect(reading?.hoursRemaining).toBeNull();
    });

    test("estimates hoursRemaining from energy_now / power_now while discharging", async () => {
        writeBatteryFixture({
            capacity: "60\n",
            status: "Discharging\n",
            energy_now: "40000000\n", // 40 Wh in µWh
            power_now: "10000000\n",  // 10 W in µW → 4 hours
        });
        const reading = await readBattery();
        expect(reading?.hoursRemaining).toBeCloseTo(4, 5);
    });

    test("falls back to charge_now / current_now when energy unavailable", async () => {
        writeBatteryFixture({
            capacity: "50\n",
            status: "Discharging\n",
            charge_now: "3000000\n",   // 3 Ah in µAh
            current_now: "1500000\n",  // 1.5 A in µA → 2 hours
        });
        const reading = await readBattery();
        expect(reading?.hoursRemaining).toBeCloseTo(2, 5);
    });
});

describe("formatBatteryReply", () => {
    test("charging shape", () => {
        expect(formatBatteryReply({ capacity: 78, status: "Charging", hoursRemaining: null }))
            .toBe("78%, charging.");
    });

    test("full shape", () => {
        expect(formatBatteryReply({ capacity: 100, status: "Full", hoursRemaining: null }))
            .toBe("100%, plugged in and topped up.");
    });

    test("discharging with hours estimate (>=1.5h rounds to hours)", () => {
        const text = formatBatteryReply({
            capacity: 65,
            status: "Discharging",
            hoursRemaining: 3.7,
        });
        expect(text).toBe("65%, discharging — about 4 hours at this rate.");
    });

    test("discharging with sub-1.5h estimate switches to minutes", () => {
        const text = formatBatteryReply({
            capacity: 12,
            status: "Discharging",
            hoursRemaining: 0.5,
        });
        expect(text).toBe("12%, discharging — about 30 minutes at this rate.");
    });

    test("discharging without estimate just reports %", () => {
        const text = formatBatteryReply({
            capacity: 55,
            status: "Discharging",
            hoursRemaining: null,
        });
        expect(text).toBe("55%, discharging.");
    });
});

describe("BATTERY_STATUS_ACTION handler", () => {
    test("replies with AC-power line when no battery present", async () => {
        let received: { text: string } | null = null;
        const callback = async (resp: { text?: string }) => {
            received = { text: resp.text ?? "" };
            return [];
        };
        const result = await BATTERY_STATUS_ACTION.handler!(
            fakeRuntime,
            memoryOf("what's my battery"),
            fakeState,
            {},
            callback,
            [],
        );
        expect(received).not.toBeNull();
        expect((received as { text: string } | null)?.text).toContain("AC power");
        expect((result as { text: string }).text).toContain("AC power");
    });

    test("replies with percent + state when battery exists", async () => {
        writeBatteryFixture({ capacity: "42\n", status: "Discharging\n" });
        let received = "";
        const callback = async (resp: { text?: string }) => {
            received = resp.text ?? "";
            return [];
        };
        await BATTERY_STATUS_ACTION.handler!(
            fakeRuntime,
            memoryOf("battery level"),
            fakeState,
            {},
            callback,
            [],
        );
        expect(received).toBe("42%, discharging.");
    });

    test("validate is always true (deterministic responder)", async () => {
        expect(await BATTERY_STATUS_ACTION.validate?.(fakeRuntime, memoryOf("anything"))).toBe(true);
    });

    test("similes include the spec phrases verbatim", () => {
        expect(BATTERY_STATUS_ACTION.similes).toContain("what's my battery");
        expect(BATTERY_STATUS_ACTION.similes).toContain("battery level");
        expect(BATTERY_STATUS_ACTION.similes).toContain("how much battery");
        expect(BATTERY_STATUS_ACTION.similes).toContain("am i charged");
        expect(BATTERY_STATUS_ACTION.similes).toContain("battery");
    });
});

describe("readCalibrationTimezone", () => {
    test("returns null when the file doesn't exist", async () => {
        const tz = await readCalibrationTimezone();
        expect(tz).toBeNull();
    });

    test("returns null when the file has no timezone field", async () => {
        writeFileSync(
            process.env.USBELIZA_CALIBRATION_FILE!,
            `schema_version = 1\ncreated_at = "2026-05-11T00:00:00Z"\nname = "Charlie"\n`,
        );
        const tz = await readCalibrationTimezone();
        expect(tz).toBeNull();
    });

    test("parses a timezone string out of the toml", async () => {
        writeFileSync(
            process.env.USBELIZA_CALIBRATION_FILE!,
            `schema_version = 1\nname = "Charlie"\ntimezone = "America/Los_Angeles"\n`,
        );
        const tz = await readCalibrationTimezone();
        expect(tz).toBe("America/Los_Angeles");
    });

    test("ignores comment lines and leading whitespace", async () => {
        writeFileSync(
            process.env.USBELIZA_CALIBRATION_FILE!,
            `# generated by usbeliza\ntimezone = "UTC"\n`,
        );
        const tz = await readCalibrationTimezone();
        expect(tz).toBe("UTC");
    });
});

describe("formatTimeReply", () => {
    test("renders the system zone when no tz given", () => {
        const reply = formatTimeReply(new Date("2026-05-11T20:00:00Z"), null);
        expect(reply.startsWith("It's ")).toBe(true);
        expect(reply.endsWith(".")).toBe(true);
    });

    test("honors a specified IANA timezone", () => {
        // 20:00Z is 13:00 PDT (May → DST active) — but we check
        // formatting properties, not exact wall time, to stay robust to
        // future DST table changes in tzdata.
        const reply = formatTimeReply(new Date("2026-05-11T20:00:00Z"), "America/Los_Angeles");
        expect(reply).toMatch(/^It's \d{1,2}:\d{2} (AM|PM) (PDT|PST|GMT-\d+)\.$/);
    });

    test("falls back gracefully on an invalid timezone", () => {
        const reply = formatTimeReply(new Date("2026-05-11T20:00:00Z"), "Not/A_Real_Zone");
        // Either we fell back to system tz (one sentence with .) — never throw.
        expect(reply.startsWith("It's ")).toBe(true);
        expect(reply.endsWith(".")).toBe(true);
    });
});

describe("CURRENT_TIME_ACTION handler", () => {
    test("emits one sentence of warm prose", async () => {
        let received = "";
        const callback = async (resp: { text?: string }) => {
            received = resp.text ?? "";
            return [];
        };
        await CURRENT_TIME_ACTION.handler!(
            fakeRuntime,
            memoryOf("what time is it"),
            fakeState,
            {},
            callback,
            [],
        );
        expect(received.startsWith("It's ")).toBe(true);
        // One sentence — exactly one period at the end, no newlines.
        expect(received.endsWith(".")).toBe(true);
        expect(received.includes("\n")).toBe(false);
    });

    test("uses the calibrated timezone when calibration.toml has one", async () => {
        writeFileSync(process.env.USBELIZA_CALIBRATION_FILE!, `timezone = "UTC"\n`);
        let received = "";
        const callback = async (resp: { text?: string }) => {
            received = resp.text ?? "";
            return [];
        };
        await CURRENT_TIME_ACTION.handler!(
            fakeRuntime,
            memoryOf("what time"),
            fakeState,
            {},
            callback,
            [],
        );
        // Either "UTC" or "GMT" depending on ICU build; both are correct
        // surface names for the UTC zone.
        expect(received).toMatch(/(UTC|GMT)/);
    });

    test("validate is always true", async () => {
        expect(await CURRENT_TIME_ACTION.validate?.(fakeRuntime, memoryOf("anything"))).toBe(true);
    });

    test("similes include the spec phrases verbatim", () => {
        expect(CURRENT_TIME_ACTION.similes).toContain("what time is it");
        expect(CURRENT_TIME_ACTION.similes).toContain("what's the time");
        expect(CURRENT_TIME_ACTION.similes).toContain("what time");
        expect(CURRENT_TIME_ACTION.similes).toContain("tell me the time");
        expect(CURRENT_TIME_ACTION.similes).toContain("current time");
    });
});
