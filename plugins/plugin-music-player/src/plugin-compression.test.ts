import { describe, expect, it } from "vitest";
import musicPlayerPlugin from "./index";

describe("music player plugin compression", () => {
  it("does not register instruction-only providers", () => {
    expect(musicPlayerPlugin.providers).toEqual([]);
  });

  it("keeps playback controls registered as actions", () => {
    expect(musicPlayerPlugin.actions?.map((action) => action.name)).toEqual(
      expect.arrayContaining([
        "PLAY_AUDIO",
        "QUEUE_MUSIC",
        "PAUSE_MUSIC",
        "RESUME_MUSIC",
        "STOP_MUSIC",
        "SKIP_TRACK",
      ]),
    );
  });
});
