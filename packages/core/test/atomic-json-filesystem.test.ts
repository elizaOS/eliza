import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
	readJsonFile,
	writeJsonAtomic,
	writeJsonAtomicSync,
} from "../src/utils/atomic-json.js";

function writer(file: string, name: string, mode: string, boundary = "") {
	const child = spawn(
		"bun",
		[
			path.join(import.meta.dirname, "fixtures/atomic-json-writer.ts"),
			file,
			name,
			mode,
			boundary,
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 20_000,
			killSignal: "SIGKILL",
		},
	);
	const reached = Promise.withResolvers<void>();
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		if (stdout.includes(`${boundary}\n`)) reached.resolve();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	return {
		child,
		exited,
		waitForBoundary() {
			return Promise.race([
				reached.promise,
				exited.then((result) => {
					throw new Error(
						`Writer exited before ${boundary}: ${JSON.stringify(result)} ${stderr}`,
					);
				}),
			]);
		},
		async finish() {
			expect(await exited, stderr).toEqual({ code: 0, signal: null });
		},
	};
}

it("readers observe complete snapshots across independent async and sync writer processes", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "core-atomic-json-"));
	const file = path.join(directory, "state.json");
	writeJsonAtomicSync(file, {
		writer: "initial",
		revision: 0,
		payload: "initial".repeat(16_384),
	});
	const children = [
		writer(file, "async", "async"),
		writer(file, "sync", "sync"),
	];
	let finished = false;
	const writing = Promise.allSettled(
		children.map((child) => child.finish()),
	).then((results) => {
		finished = true;
		return results;
	});
	try {
		do {
			const snapshot = JSON.parse(readFileSync(file, "utf8"));
			expect(["initial", "async", "sync"]).toContain(snapshot.writer);
			expect(snapshot.payload).toBe(snapshot.writer.repeat(16_384));
			expect(snapshot.revision).toBeGreaterThanOrEqual(0);
			expect(snapshot.revision).toBeLessThan(30);
			await setImmediate();
		} while (!finished);
		for (const result of await writing) {
			if (result.status === "rejected") throw result.reason;
		}
		expect(readdirSync(directory)).toEqual(["state.json"]);
	} finally {
		for (const { child } of children) child.kill("SIGKILL");
		await Promise.all(children.map((child) => child.exited));
		rmSync(directory, { recursive: true, force: true });
	}
});

it("same-target async writes retain invocation order while publication is pending", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "core-atomic-json-"));
	const file = path.join(directory, "state.json");
	writeJsonAtomicSync(file, { revision: 0 });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const rename = fsp.rename.bind(fsp);
	const hold = vi
		.spyOn(fsp, "rename")
		.mockImplementationOnce(async (source, destination) => {
			entered.resolve();
			await release.promise;
			await rename(source, destination);
		});
	const first = writeJsonAtomic(file, { revision: 1 });
	let second: Promise<void> | undefined;
	try {
		await entered.promise;
		second = writeJsonAtomic(path.join(directory, ".", "state.json"), {
			revision: 2,
		});
		await setImmediate();
		expect(await readJsonFile(file)).toEqual({ revision: 0 });
		expect(
			readdirSync(directory).filter((name) => name !== "state.json"),
		).toHaveLength(1);
		release.resolve();
		await Promise.all([first, second]);
		expect(await readJsonFile(file)).toEqual({ revision: 2 });
		expect(readdirSync(directory)).toEqual(["state.json"]);
	} finally {
		release.resolve();
		await Promise.allSettled([first, ...(second ? [second] : [])]);
		hold.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("rename failures preserve the destination and later async writes remain usable", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "core-atomic-json-"));
	const file = path.join(directory, "state.json");
	mkdirSync(file);
	writeFileSync(path.join(file, "keep"), "original");
	try {
		const results = await Promise.allSettled([
			writeJsonAtomic(file, { revision: 1 }),
			writeJsonAtomic(file, { revision: 2 }),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"rejected",
			"rejected",
		]);
		expect(() => writeJsonAtomicSync(file, { revision: 3 })).toThrow();
		expect(readFileSync(path.join(file, "keep"), "utf8")).toBe("original");
		expect(readdirSync(directory)).toEqual(["state.json"]);
		rmSync(file, { recursive: true });
		await writeJsonAtomic(file, { revision: 4 });
		expect(await readJsonFile(file)).toEqual({ revision: 4 });
		expect(readdirSync(directory)).toEqual(["state.json"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

for (const boundary of ["before-rename", "after-rename"]) {
	it(`process termination ${boundary} retains the published snapshot and permits a fresh writer`, async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "core-atomic-json-"));
		const file = path.join(directory, "state.json");
		writeJsonAtomicSync(file, { writer: "initial" });
		const child = writer(file, "retired", "async", boundary);
		try {
			await child.waitForBoundary();
			child.child.kill("SIGKILL");
			expect(await child.exited).toEqual({ code: null, signal: "SIGKILL" });
			const snapshot = await readJsonFile<{ writer: string; payload?: string }>(
				file,
			);
			expect(snapshot?.writer).toBe(
				boundary === "before-rename" ? "initial" : "retired",
			);
			if (boundary === "after-rename")
				expect(snapshot?.payload).toBe("retired".repeat(16_384));
			const stranded = readdirSync(directory).filter(
				(name) => name !== "state.json",
			);
			expect(stranded).toHaveLength(boundary === "before-rename" ? 1 : 0);
			for (const name of stranded) {
				expect(
					JSON.parse(readFileSync(path.join(directory, name), "utf8")),
				).toEqual({
					writer: "retired",
					revision: 0,
					payload: "retired".repeat(16_384),
				});
			}
			await writer(file, "fresh", "async").finish();
			expect((await readJsonFile<{ writer: string }>(file))?.writer).toBe(
				"fresh",
			);
			expect(
				readdirSync(directory).filter((name) => name !== "state.json"),
			).toEqual(stranded);
		} finally {
			child.child.kill("SIGKILL");
			await child.exited;
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
