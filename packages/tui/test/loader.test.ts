import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Loader } from "../src/components/loader.js";
import type { TUI } from "../src/tui.js";

/**
 * Minimal mock TUI for Loader tests.
 * Loader only uses requestRender(), so we mock just that method.
 * Uses Pick<TUI, 'requestRender'> to ensure type alignment with actual TUI.
 */
type MockTUI = Pick<TUI, "requestRender"> & {
	requestRender: ReturnType<typeof mock>;
};

describe("Loader component", () => {
	const createMockTUI = (): MockTUI => ({
		requestRender: vi.fn(() => {}),
	});

	let loader: Loader;
	let mockTUI: MockTUI;

	beforeEach(() => {
		mockTUI = createMockTUI();
	});

	afterEach(() => {
		// Stop the loader to clear any intervals
		if (loader) {
			loader.stop();
		}
	});

	// Cast helper - Loader only uses requestRender(), so partial mock is safe.
	// We use 'as unknown as TUI' because MockTUI is intentionally a subset.
	const asTUI = (m: MockTUI): TUI => m as unknown as TUI;

	describe("constructor", () => {
		test("creates Loader with default message", () => {
			loader = new Loader(asTUI(mockTUI), (s) => s, (s) => s);
			const lines = loader.render(40);
			// Should render spinner + message
			expect(lines.some((l) => l.includes("Loading..."))).toBe(true);
		});

		test("creates Loader with custom message", () => {
			loader = new Loader(asTUI(mockTUI), (s) => s, (s) => s, "Processing...");
			const lines = loader.render(40);
			expect(lines.some((l) => l.includes("Processing..."))).toBe(true);
		});

		test("applies spinner color function", () => {
			loader = new Loader(asTUI(mockTUI), (s) => `[SPIN]${s}[/SPIN]`, (s) => s);
			const lines = loader.render(40);
			expect(lines.some((l) => l.includes("[SPIN]"))).toBe(true);
		});

		test("applies message color function", () => {
			loader = new Loader(asTUI(mockTUI), (s) => s, (s) => `[MSG]${s}[/MSG]`);
			const lines = loader.render(40);
			expect(lines.some((l) => l.includes("[MSG]Loading...[/MSG]"))).toBe(true);
		});
	});

	describe("render", () => {
		test("renders with empty first line", () => {
			loader = new Loader(asTUI(mockTUI), (s) => s, (s) => s);
			const lines = loader.render(40);
			// First line should be empty (for spacing)
			expect(lines[0]).toBe("");
			expect(lines.length).toBeGreaterThan(1);
		});
	});

	describe("setMessage", () => {
		test("updates message", () => {
			loader = new Loader(asTUI(mockTUI), (s) => s, (s) => s, "Initial");
			loader.setMessage("Updated");
			const lines = loader.render(40);
			expect(lines.some((l) => l.includes("Updated"))).toBe(true);
			expect(lines.some((l) => l.includes("Initial"))).toBe(false);
		});

		test("triggers render request", () => {
			loader = new Loader(asTUI(mockTUI), (s) => s, (s) => s);
			// Reset mock to clear constructor call
			mockTUI.requestRender.mockClear();
			loader.setMessage("New message");
			expect(mockTUI.requestRender).toHaveBeenCalled();
		});
	});

	describe("start/stop", () => {
		test("stop prevents further animations", async () => {
			loader = new Loader(asTUI(mockTUI), (s) => s, (s) => s);
			loader.stop();
			// Reset mock to clear previous calls
			mockTUI.requestRender.mockClear();
			// Wait a bit and verify no more render requests
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(mockTUI.requestRender).not.toHaveBeenCalled();
		});

		test("multiple stop calls are safe", () => {
			loader = new Loader(asTUI(mockTUI), (s) => s, (s) => s);
			expect(() => {
				loader.stop();
				loader.stop();
			}).not.toThrow();
		});
	});
});
