// Verifies explicit per-user rollback-state locations for packaged apps.
import { describe, expect, it } from "vitest";
import { RELEASE_SEQUENCE_STATE_PATH_ENV } from "../backend/release-sequence-store";
import { configurePackagedReleaseSequenceState } from "../packaged-runtime-config";

describe("packaged release sequence state", () => {
  it.each([
    [
      "darwin",
      "/Users/eliza/Library/Application Support/elizaOS/usb-installer/release-sequence.json",
    ],
    [
      "linux",
      "/home/eliza/.local/state/elizaOS/usb-installer/release-sequence.json",
    ],
    [
      "win32",
      "C:\\Users\\eliza\\AppData\\Local\\elizaOS\\usb-installer\\release-sequence.json",
    ],
  ] as const)(
    "selects an absolute per-user path on %s",
    (platform, expected) => {
      const env: NodeJS.ProcessEnv = {};
      expect(
        configurePackagedReleaseSequenceState(
          env,
          platform,
          platform === "linux"
            ? "/home/eliza"
            : platform === "win32"
              ? "C:\\Users\\eliza"
              : "/Users/eliza",
        ),
      ).toBe(expected);
      expect(env[RELEASE_SEQUENCE_STATE_PATH_ENV]).toBe(expected);
    },
  );

  it("preserves an explicit release input and rejects a relative state root", () => {
    const explicit = "/managed/state/release-sequence.json";
    expect(
      configurePackagedReleaseSequenceState(
        { [RELEASE_SEQUENCE_STATE_PATH_ENV]: explicit },
        "darwin",
        "/Users/eliza",
      ),
    ).toBe(explicit);
    expect(() =>
      configurePackagedReleaseSequenceState(
        { XDG_STATE_HOME: "relative/state" },
        "linux",
        "/home/eliza",
      ),
    ).toThrow("must be absolute");
    expect(() =>
      configurePackagedReleaseSequenceState(
        { [RELEASE_SEQUENCE_STATE_PATH_ENV]: "relative/state.json" },
        "win32",
        "C:\\Users\\eliza",
      ),
    ).toThrow("must be absolute");
  });
});
