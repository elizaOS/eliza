/** Locks native launch replay behind protected-storage hydration without delaying voice prewarm. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  join(import.meta.dirname, "../src/main.tsx"),
  "utf8",
);

describe("native launch storage order", () => {
  it("hydrates protected credentials before applying a retained launch URL", () => {
    const voicePrewarm = mainSource.indexOf(
      "const voiceModuleReady = startVoiceModuleLoad();",
    );
    const storageHydration = mainSource.indexOf(
      "await initializeStorageBridge();",
      voicePrewarm,
    );
    const launchReplay = mainSource.indexOf(
      "await applyLaunchConnectionFromUrl();",
      storageHydration,
    );

    expect(voicePrewarm).toBeGreaterThan(-1);
    expect(storageHydration).toBeGreaterThan(voicePrewarm);
    expect(launchReplay).toBeGreaterThan(storageHydration);
  });
});
