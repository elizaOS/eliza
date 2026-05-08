import { describe, expect, it } from "vitest";
import musicPlayerPlugin from "./index";

describe("music player plugin compression", () => {
  it("registers musicQueue provider only", () => {
    expect(
      musicPlayerPlugin.providers?.map((provider) => provider.name),
    ).toEqual(["musicQueue"]);
  });

  it("registers the compressed action set", () => {
    expect(musicPlayerPlugin.actions?.map((action) => action.name)).toEqual([
      "PLAYBACK",
      "MANAGE_ROUTING",
      "MANAGE_ZONES",
      "PLAY_AUDIO",
    ]);
  });

  it("exposes the compressed PLAYBACK_OP descCompressed", () => {
    const action = musicPlayerPlugin.actions?.find(
      (a) => a.name === "PLAYBACK",
    );
    expect(action?.descriptionCompressed).toBe(
      "Music playback ops: pause, resume, skip, stop, queue.",
    );
  });
});
