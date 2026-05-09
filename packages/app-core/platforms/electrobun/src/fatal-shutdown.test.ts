import { describe, expect, it, vi } from "vitest";
import { shutdownAfterFatalError } from "./fatal-shutdown";
import { Utils } from "electrobun/bun";

vi.mock("electrobun/bun", () => ({
	Utils: {
		quit: vi.fn(),
	},
}));

// Rule (electrobun.md:601-610):
//   Don't use process.exit() for shutdown — use Utils.quit() for graceful
//   shutdown with CEF cleanup.
//
// Current code (src/fatal-shutdown.ts):
//   export function shutdownAfterFatalError(): void {
//     process.exit(1);
//   }

describe("fatal startup shutdown", () => {
	it("does not call process.exit()", () => {
		const processExitSpy = vi.spyOn(process, "exit");

		shutdownAfterFatalError();

		// RED: currently calls process.exit(1) — should call Utils.quit()
		expect(processExitSpy).not.toHaveBeenCalled();
		expect(Utils.quit).toHaveBeenCalledOnce();
	});
});
