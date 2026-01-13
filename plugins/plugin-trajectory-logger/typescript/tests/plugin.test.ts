import { describe, expect, it } from "vitest";
import { trajectoryLoggerPlugin } from "../index";

describe("plugin-trajectory-logger", () => {
  it("exports plugin metadata", () => {
    expect(trajectoryLoggerPlugin.name).toBe("@elizaos/plugin-trajectory-logger");
    expect(trajectoryLoggerPlugin.description).toContain("trajectory");
  });
});
