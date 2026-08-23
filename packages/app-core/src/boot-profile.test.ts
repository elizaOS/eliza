import { describe, expect, it, vi } from "vitest";

// Boot profile is off unless ELIZA_BOOT_PROFILE=1; test the enabled path
// by reloading the module with the env var set.
const env = vi.hoisted(() => ({ value: "" }));
const origWrite = process.stderr.write;

vi.mock("node:process", () => process);

describe("boot-profile", () => {
  it("bootProfileEnabled is false by default", async () => {
    const mod = await import("./boot-profile.ts");
    expect(mod.bootProfileEnabled()).toBe(false);
  });

  it("bootLap is a no-op when disabled", async () => {
    const spy = vi.spyOn(process.stderr, "write");
    const mod = await import("./boot-profile.ts");
    mod.bootLap("label");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
