import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const handoffScript = path.join(here, "eliza-assistant-handoff.sh");

describe("macOS Shortcuts assistant handoff", () => {
  it("builds the assistant deep link used by the desktop runtime", async () => {
    const { stdout } = await execFileAsync("sh", [
      handoffScript,
      "--dry-run",
      "Remind me at 5 & call mom",
    ]);

    expect(stdout.trim()).toBe(
      "elizaos://assistant?text=Remind%20me%20at%205%20%26%20call%20mom&source=macos-shortcuts&action=ask",
    );
  });

  it("honors scheme, source, and action overrides", async () => {
    const { stdout } = await execFileAsync("sh", [
      handoffScript,
      "--dry-run",
      "--scheme",
      "milady",
      "--source",
      "macos-siri",
      "--action",
      "lifeops.create",
      "check in on me tomorrow morning",
    ]);

    expect(stdout.trim()).toBe(
      "milady://assistant?text=check%20in%20on%20me%20tomorrow%20morning&source=macos-siri&action=lifeops.create",
    );
  });
});
