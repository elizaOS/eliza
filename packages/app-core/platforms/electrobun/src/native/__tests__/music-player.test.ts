import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveInitialApiBase: vi.fn(),
  getBrandConfig: vi.fn(() => ({ desktopMusicGuildId: "guild-main" })),
  getAgentManager: vi.fn(),
}));

vi.mock("../api-base", () => ({
  resolveInitialApiBase: (...a: unknown[]) => mocks.resolveInitialApiBase(...a),
}));
vi.mock("../brand-config", () => ({
  getBrandConfig: (...a: unknown[]) => mocks.getBrandConfig(...a),
}));
vi.mock("./agent", () => ({
  getAgentManager: (...a: unknown[]) => mocks.getAgentManager(...a),
}));

import {
  DEFAULT_DESKTOP_MUSIC_GUILD_ID,
  getMusicPlayerManager,
  MusicPlayerManager,
} from "../music-player.ts";

describe("MusicPlayerManager", () => {
  beforeEach(() => {
    mocks.getAgentManager.mockReset();
    mocks.resolveInitialApiBase.mockReset();
  });

  it("resolves URLs from the embedded agent port", () => {
    mocks.getAgentManager.mockReturnValue({ getPort: () => 4123 });
    const urls = new MusicPlayerManager().getDesktopPlaybackUrls();
    expect(urls.ok).toBe(true);
    expect(urls.streamUrl).toBe(
      "http://127.0.0.1:4123/music-player/stream?guildId=guild-main",
    );
    expect(urls.apiBase).toBe("http://127.0.0.1:4123");
  });

  it("falls back to the initial api base when no port is live", () => {
    mocks.getAgentManager.mockReturnValue({ getPort: () => null });
    mocks.resolveInitialApiBase.mockReturnValue("http://localhost:3000/");
    const urls = new MusicPlayerManager().getDesktopPlaybackUrls();
    expect(urls.ok).toBe(true);
    expect(urls.apiBase).toBe("http://localhost:3000");
    expect(urls.queueUrl).toContain("/music-player/queue?guildId=");
  });

  it("returns a failure when no api base is resolvable", () => {
    mocks.getAgentManager.mockReturnValue({ getPort: () => null });
    mocks.resolveInitialApiBase.mockReturnValue(null);
    const urls = new MusicPlayerManager().getDesktopPlaybackUrls();
    expect(urls.ok).toBe(false);
    expect(urls.reason).toContain("ELIZA_API_PORT");
  });

  it("encodes a custom guild id", () => {
    mocks.getAgentManager.mockReturnValue({ getPort: () => 4123 });
    const urls = new MusicPlayerManager().getDesktopPlaybackUrls({
      guildId: "a b&c",
    });
    expect(urls.guildId).toBe("a b&c");
    expect(urls.streamUrl).toContain("guildId=a%20b%26c");
  });

  it("singleton getter returns the same instance", () => {
    expect(getMusicPlayerManager()).toBe(getMusicPlayerManager());
  });

  it("exposes the default guild id", () => {
    expect(DEFAULT_DESKTOP_MUSIC_GUILD_ID).toBe("guild-main");
  });
});
