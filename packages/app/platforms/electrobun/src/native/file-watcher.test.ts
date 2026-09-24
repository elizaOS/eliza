/** Exercises real filesystem delivery beneath ignored-looking workspace ancestors and ignores generated descendants. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { type FileChangeEvent, getFileWatcher } from "./file-watcher";

it("delivers source edits beneath hidden ancestors while ignoring generated descendants", async () => {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-watch-"));
	const root = path.join(temporary, ".workspace", "build", "project");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
	const source = path.join(root, "src", "entry.ts");
	fs.writeFileSync(source, "initial");
	const events: FileChangeEvent[] = [];
	const watcher = getFileWatcher();
	const id = watcher.startWatch(root, (event) => events.push(event));
	try {
		fs.writeFileSync(
			path.join(root, "node_modules", "generated.js"),
			"ignored",
		);
		let revision = 0;
		await expect
			.poll(
				() => {
					// Recursive OS watchers can finish subscribing after startWatch returns.
					// Keep editing until a real event arrives instead of racing that setup.
					fs.writeFileSync(source, `changed ${++revision}`);
					return events.some((event) => event.filePath === source);
				},
				{
					timeout: 3000,
				},
			)
			.toBe(true);
		expect(
			events.some((event) => event.relativePath.includes("node_modules")),
		).toBe(false);
	} finally {
		watcher.stopWatch(id);
		fs.rmSync(temporary, { recursive: true, force: true });
	}
});
