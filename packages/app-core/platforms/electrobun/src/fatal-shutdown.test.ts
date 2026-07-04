/** Exercises fatal shutdown behavior with deterministic app-core test fixtures. */
import { Utils } from "electrobun/bun";
import { describe, expect, it, vi } from "vitest";
import { shutdownAfterFatalError } from "./fatal-shutdown";

vi.mock("electrobun/bun", () => ({
  Utils: {
    quit: vi.fn(),
  },
}));

// Rule (electrobun.md:601-610):
//   Don't use process.exit() for shutdown — use Utils.quit() for graceful
//   shutdown with CEF cleanup. shutdownAfterFatalError() must therefore call
//   Utils.quit() (not process.exit) so CEF/native destructors run on a fatal
//   startup error.

describe("fatal startup shutdown", () => {
  it("does not call process.exit()", () => {
    const processExitSpy = vi.spyOn(process, "exit");

    shutdownAfterFatalError();

    expect(processExitSpy).not.toHaveBeenCalled();
    expect(Utils.quit).toHaveBeenCalledOnce();
  });
});
