import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { close, resetForTesting, write } from "./logger";

describe("logger file output", () => {
	const originalEnv = process.env;
	const testDir = path.join(process.cwd(), "test-logs");
	const defaultFiles = ["output.log", "prompts.log", "chat.log"];

	beforeEach(() => {
		process.env = { ...originalEnv };
		// Create test directory
		if (!fs.existsSync(testDir)) {
			fs.mkdirSync(testDir);
		}
		resetForTesting();
	});

	afterEach(() => {
		process.env = originalEnv;
		close(); // Clean up file descriptors

		// Clean up test files
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	it("creates log files when LOG_FILE=true", () => {
		process.env.LOG_FILE = "true";

		write("test message");

		for (const file of defaultFiles) {
			const logPath = path.join(process.cwd(), file);
			expect(fs.existsSync(logPath)).toBe(true);
			const content = fs.readFileSync(logPath, "utf8");
			expect(content).toContain("test message");
		}
	});

	it("appends to existing log files instead of truncating", () => {
		process.env.LOG_FILE = "true";

		write("first message");
		const initialSizes = defaultFiles.map(
			(file) => fs.statSync(path.join(process.cwd(), file)).size,
		);

		resetForTesting();
		write("second message");

		defaultFiles.forEach((file, i) => {
			const logPath = path.join(process.cwd(), file);
			const newSize = fs.statSync(logPath).size;
			expect(newSize).toBeGreaterThan(initialSizes[i]);
			const content = fs.readFileSync(logPath, "utf8");
			expect(content).toContain("first message");
			expect(content).toContain("second message");
		});
	});

	it("respects custom LOG_FILE path", () => {
		const customPath = path.join(testDir, "custom.log");
		process.env.LOG_FILE = customPath;

		write("custom path test");

		expect(fs.existsSync(customPath)).toBe(true);
		const content = fs.readFileSync(customPath, "utf8");
		expect(content).toContain("custom path test");
	});

	it("disables logging when LOG_FILE is false/0/empty", () => {
		// Test with false
		process.env.LOG_FILE = "false";
		write("should not log");

		for (const file of defaultFiles) {
			const logPath = path.join(process.cwd(), file);
			expect(fs.existsSync(logPath)).toBe(false);
		}

		// Test with 0
		process.env.LOG_FILE = "0";
		write("should not log");

		for (const file of defaultFiles) {
			const logPath = path.join(process.cwd(), file);
			expect(fs.existsSync(logPath)).toBe(false);
		}

		// Test with empty string
		process.env.LOG_FILE = "";
		write("should not log");

		for (const file of defaultFiles) {
			const logPath = path.join(process.cwd(), file);
			expect(fs.existsSync(logPath)).toBe(false);
		}
	});

	it("closes file descriptors on exit", () => {
		process.env.LOG_FILE = "true";

		write("test cleanup");
		// Get open file descriptors before close
		const beforeFds = fs.readdirSync("/proc/self/fd").length;

		close();

		// Get open file descriptors after close
		const afterFds = fs.readdirSync("/proc/self/fd").length;
		expect(afterFds).toBeLessThan(beforeFds);

		// Verify we can write again after closing
		write("test reopen");
		for (const file of defaultFiles) {
			const logPath = path.join(process.cwd(), file);
			const content = fs.readFileSync(logPath, "utf8");
			expect(content).toContain("test reopen");
		}
	});
});
