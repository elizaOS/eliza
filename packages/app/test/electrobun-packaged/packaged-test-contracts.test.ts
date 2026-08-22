/**
 * Deterministic unit coverage for packaged-desktop evidence and persistence
 * contracts; no native process, compositor, or renderer is launched.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { classifyPackagedDisplaySession } from "./packaged-app-helpers";
import {
  analyzePackagedScreenshotSignal,
  assessReturningInstallPersistence,
  formatStoragePersistenceFailure,
  packagedScreenshotSignalIssues,
  type ReturningInstallStorageSnapshot,
} from "./packaged-test-contracts";

const RETURNING_INSTALL: ReturningInstallStorageSnapshot = {
  origin: "http://127.0.0.1:5174",
  firstRunComplete: "1",
  setupStep: "activate",
  uiShellMode: "native",
  activeServer: '{"id":"remote:http://127.0.0.1:31337"}',
};

describe("packaged test contracts", () => {
  it("fails relaunch persistence when any seeded key disappears", () => {
    expect(
      assessReturningInstallPersistence(RETURNING_INSTALL, {
        ...RETURNING_INSTALL,
        firstRunComplete: null,
        activeServer: null,
      }),
    ).toEqual({
      ok: false,
      mismatches: [
        { key: "firstRunComplete", before: "1", after: null },
        {
          key: "activeServer",
          before: '{"id":"remote:http://127.0.0.1:31337"}',
          after: null,
        },
      ],
    });
  });

  it("accepts an exact returning-install snapshot across relaunch", () => {
    expect(
      assessReturningInstallPersistence(RETURNING_INSTALL, {
        ...RETURNING_INSTALL,
      }),
    ).toEqual({ ok: true, mismatches: [] });
  });

  it("redacts active-server contents from relaunch diagnostics", () => {
    const secretBearingServer =
      '{"id":"remote:test","accessToken":"must-not-appear"}';
    const message = formatStoragePersistenceFailure({
      before: { ...RETURNING_INSTALL, activeServer: secretBearingServer },
      after: { ...RETURNING_INSTALL, activeServer: null },
      partition: "persist:test",
      stateDir: "/tmp/test-state",
    });

    expect(message).toContain("activeServer: before=present(length=");
    expect(message).not.toContain("must-not-appear");
  });

  it("labels a dedicated Linux xvfb launch as structural-only placement evidence", () => {
    expect(
      classifyPackagedDisplaySession({
        platform: "linux",
        useCurrentDisplay: false,
        xvfbRunAvailable: true,
      }),
    ).toBe("dedicated-xvfb-without-window-manager");
    expect(
      classifyPackagedDisplaySession({
        platform: "linux",
        useCurrentDisplay: true,
        xvfbRunAvailable: true,
      }),
    ).toBe("desktop-session");
  });

  it("rejects a near-black frame whose only paint is a small white handle", async () => {
    const image = sharp({
      create: {
        width: 1240,
        height: 860,
        channels: 3,
        background: "#000000",
      },
    }).composite([
      {
        input: await sharp({
          create: {
            width: 48,
            height: 10,
            channels: 3,
            background: "#ffffff",
          },
        })
          .png()
          .toBuffer(),
        left: 596,
        top: 830,
      },
    ]);
    const signal = await analyzePackagedScreenshotSignal(
      await image.png().toBuffer(),
    );

    expect(packagedScreenshotSignalIssues("launch", signal)).not.toEqual([]);
    expect(signal.activeRowRatio).toBeLessThan(0.06);
  });

  it("accepts UI signal distributed across a substantial frame area", async () => {
    const panel = await sharp({
      create: {
        width: 900,
        height: 620,
        channels: 3,
        background: "#2b2521",
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 620,
              height: 48,
              channels: 3,
              background: "#ff5800",
            },
          })
            .png()
            .toBuffer(),
          left: 80,
          top: 80,
        },
      ])
      .png()
      .toBuffer();
    const image = sharp({
      create: {
        width: 1240,
        height: 860,
        channels: 3,
        background: "#000000",
      },
    }).composite([{ input: panel, left: 170, top: 120 }]);
    const signal = await analyzePackagedScreenshotSignal(
      await image.png().toBuffer(),
    );

    expect(packagedScreenshotSignalIssues("launch", signal)).toEqual([]);
  });
});
