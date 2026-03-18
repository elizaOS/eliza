import assert from "node:assert";
import { describe, it } from "vitest";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class StaticLines implements Component {
	constructor(private readonly lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class StaticOverlay implements Component {
	constructor(private readonly line: string) {}

	render(): string[] {
		return [this.line];
	}

	invalidate(): void {}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const attrs = terminal.getCellAttributes(row, col);
	assert.ok(attrs, `Missing cell at row ${row} col ${col}`);
	return attrs.isItalic;
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.flush();
}

describe("TUI overlay compositing", () => {
	it("should not leak styles when a trailing reset sits beyond the last visible column (no overlay)", async () => {
		const width = 20;
		const baseLine = `\x1b[3m${"X".repeat(width)}\x1b[23m`;

		const terminal = new VirtualTerminal(width, 6);
		const tui = new TUI(terminal);
		tui.addChild(new StaticLines([baseLine, "INPUT"]));
		tui.start();
		await renderAndFlush(tui, terminal);
		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});

	it("should not leak styles when overlay slicing drops trailing SGR resets", async () => {
		const width = 20;
		const baseLine = `\x1b[3m${"X".repeat(width)}\x1b[23m`;

		const terminal = new VirtualTerminal(width, 6);
		const tui = new TUI(terminal);
		tui.addChild(new StaticLines([baseLine, "INPUT"]));

		tui.showOverlay(new StaticOverlay("OVR"), { row: 0, col: 5, width: 3 });
		tui.start();
		await renderAndFlush(tui, terminal);

		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});
});
