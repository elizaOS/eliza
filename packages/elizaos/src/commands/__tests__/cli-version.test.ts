import { describe, expect, it, vi } from "vitest";

vi.mock("picocolors", () => ({
  default: {
    bold: (t: string) => `B:${t}`,
    cyan: (t: string) => `C:${t}`,
    dim: (t: string) => `D:${t}`,
    green: (t: string) => `G:${t}`,
  },
}));
vi.mock("../package-info.js", () => ({
  readPackageJson: () => ({ name: "elizaos", version: "1.2.3" }),
}));

import { version } from "./version.ts";

describe("version", () => {
  it("prints the package name and version", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    version();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("B:C:elizaOS CLI"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("G:1.2.3"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("elizaos"));
    log.mockRestore();
  });
});
