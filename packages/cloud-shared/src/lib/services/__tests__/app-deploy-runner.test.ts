import { describe, expect, test } from "bun:test";
import { containerNameForApp } from "../app-deploy-runner";

// #9145 — container names must be stable + DNS/Docker-safe regardless of app id.
describe("containerNameForApp (#9145)", () => {
  test("produces a lowercase app-<slug> name", () => {
    expect(containerNameForApp("MyApp")).toBe("app-myapp");
  });

  test("strips every non-alphanumeric character", () => {
    expect(containerNameForApp("a1b2-C3.D4_e5")).toBe("app-a1b2c3d4e5");
  });

  test("truncates the slug to 12 chars (16 total)", () => {
    const name = containerNameForApp("abcdefghijklmnopqrstuvwxyz");
    expect(name).toBe("app-abcdefghijkl");
    expect(name.length).toBe(16);
  });

  test("is deterministic for a UUID id", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(containerNameForApp(id)).toBe("app-550e8400e29b");
    expect(containerNameForApp(id)).toBe(containerNameForApp(id));
  });
});
