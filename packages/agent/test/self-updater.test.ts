import { expect, it } from "vitest";
import { isWindowsNpmGlobalShim } from "../src/services/install-method.ts";

it("recognizes npm's default Windows global launcher", () => {
  expect(
    isWindowsNpmGlobalShim(
      "C:\\Users\\operator\\AppData\\Roaming\\npm\\eliza.cmd",
      "win32",
    ),
  ).toBe(true);
});

it("does not classify other platforms or launchers as an npm Windows shim", () => {
  expect(
    isWindowsNpmGlobalShim(
      "C:\\Users\\operator\\AppData\\Roaming\\npm\\eliza.cmd",
      "linux",
    ),
  ).toBe(false);
  expect(
    isWindowsNpmGlobalShim(
      "C:\\Users\\operator\\.bun\\bin\\eliza.exe",
      "win32",
    ),
  ).toBe(false);
});
