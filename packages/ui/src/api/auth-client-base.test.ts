/** Android Play-cloud auth routing regression coverage. */
import { describe, expect, it } from "vitest";
import { resolveAuthBase } from "./auth-client";

describe("resolveAuthBase", () => {
  it("routes an authority-less Play Android shell to the Cloud auth API", () => {
    expect(
      resolveAuthBase({
        cloudApiBase: "https://eliza.app/",
        windowOrigin: "https://localhost",
        androidCloudBuild: true,
      }),
    ).toBe("https://api.eliza.app");
  });

  it("keeps an explicitly selected authority ahead of the Cloud default", () => {
    expect(
      resolveAuthBase({
        apiBase: "https://agent.example.com/",
        cloudApiBase: "https://eliza.app",
        windowOrigin: "https://localhost",
        androidCloudBuild: true,
      }),
    ).toBe("https://agent.example.com");
  });

  it("preserves same-origin behavior outside the Play Android build", () => {
    expect(
      resolveAuthBase({
        windowOrigin: "https://self-hosted.example/",
        androidCloudBuild: false,
      }),
    ).toBe("https://self-hosted.example");
  });
});
