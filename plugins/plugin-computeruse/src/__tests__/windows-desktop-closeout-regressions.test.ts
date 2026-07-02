/**
 * Static guards for #9581 Windows desktop evidence closeout regressions.
 *
 * These run on every OS and protect the two Windows-only failures found while
 * re-running the live harness on a current Windows host:
 * - Edge relaunching away from Puppeteer's parent process unless the relaunch
 *   skip flag is present up front.
 * - explicit list_windows returning a short-lived stale empty cache instead of
 *   the current desktop windows.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const browserSource = readFileSync(
  join(testDir, "..", "platform", "browser.ts"),
  "utf-8",
);
const serviceSource = readFileSync(
  join(testDir, "..", "services", "computer-use-service.ts"),
  "utf-8",
);
const recorderSource = readFileSync(
  join(testDir, "..", "..", "scripts", "record-windows-cua-input.mjs"),
  "utf-8",
);

describe("#9581 Windows desktop closeout guards", () => {
  it("passes the Edge relaunch skip flag before Puppeteer launch", () => {
    const flagIndex = browserSource.indexOf(
      "--edge-skip-compat-layer-relaunch",
    );
    const launchIndex = browserSource.indexOf("pup.default.launch");
    expect(
      flagIndex,
      "browser.ts must include the Edge relaunch skip flag",
    ).toBeGreaterThanOrEqual(0);
    expect(
      flagIndex,
      "the Edge relaunch skip flag must be added before Puppeteer launches",
    ).toBeLessThan(launchIndex);
  });

  it("forces explicit list_windows through a fresh enumeration", () => {
    expect(
      /import\s*\{[\s\S]*\brefreshWindows\b[\s\S]*\}\s*from\s*["']\.\.\/platform\/windows-list(\.js)?["']/.test(
        serviceSource,
      ),
      "ComputerUseService must import refreshWindows",
    ).toBe(true);
    expect(
      /case\s+["']list["']:\s*\{\s*const windows = refreshWindows\(\);/.test(
        serviceSource,
      ),
      "the user-visible list_windows action must bypass the short cache",
    ).toBe(true);
  });

  it("targets the recorder click from the controlled input target bounds", () => {
    expect(recorderSource).toContain('action: "get_window_position"');
    expect(recorderSource).toContain(
      "displayForPoint(displays, globalX, globalY)",
    );
    expect(
      /const coordinate = \[globalX - displayX, globalY - displayY\];/.test(
        recorderSource,
      ),
      "the Windows input recorder must click inside the target window's actual bounds",
    ).toBe(true);
  });
});
