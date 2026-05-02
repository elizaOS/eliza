import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import localStoragePlugin, { LocalFileStorageService } from "../src/index";

interface FakeRuntime {
	getSetting: (key: string) => unknown;
	getService: (type: string) => unknown;
}

function makeRuntime(storagePath: string): FakeRuntime {
	return {
		getSetting: (key: string) => {
			if (key === "LOCAL_STORAGE_PATH") return storagePath;
			return undefined;
		},
		getService: () => null,
	};
}

let workDir = "";
let storagePath = "";
let service: LocalFileStorageService;

beforeEach(async () => {
	workDir = await fsp.mkdtemp(path.join(tmpdir(), "eliza-local-storage-test-"));
	storagePath = path.join(workDir, "store");
	service = (await LocalFileStorageService.start(
		makeRuntime(storagePath) as unknown as Parameters<
			typeof LocalFileStorageService.start
		>[0],
	)) as LocalFileStorageService;
});

afterEach(async () => {
	await service.stop();
	await fsp.rm(workDir, { recursive: true, force: true });
});

describe("plugin export", () => {
	it("registers LocalFileStorageService under ServiceType.REMOTE_FILES", () => {
		expect(localStoragePlugin.name).toBe("local-storage");
		expect(localStoragePlugin.services).toEqual([LocalFileStorageService]);
		expect(LocalFileStorageService.serviceType).toBe("aws_s3");
	});
});

describe("LocalFileStorageService", () => {
	it("creates the storage directory on start", async () => {
		const stats = await fsp.stat(storagePath);
		expect(stats.isDirectory()).toBe(true);
		expect(service.root).toBe(storagePath);
	});

	it("uploadBytes writes a file and downloadBytes reads it back unchanged", async () => {
		const payload = Buffer.from([1, 2, 3, 4, 255, 0]);
		const uploadResult = await service.uploadBytes(
			payload,
			"binary.bin",
			"application/octet-stream",
			"subdir",
		);
		expect(uploadResult.success).toBe(true);
		expect(uploadResult.url).toBe(
			`file://${path.join(storagePath, "subdir", "binary.bin")}`,
		);
		const onDisk = await fsp.readFile(
			path.join(storagePath, "subdir", "binary.bin"),
		);
		expect(onDisk.equals(payload)).toBe(true);

		const fetched = await service.downloadBytes(
			"ignored-bucket",
			"subdir/binary.bin",
		);
		expect(Buffer.isBuffer(fetched)).toBe(true);
		expect(fetched.equals(payload)).toBe(true);
	});

	it("uploadBytes accepts Uint8Array", async () => {
		const payload = new Uint8Array([10, 20, 30]);
		const result = await service.uploadBytes(
			payload,
			"u8.bin",
			"application/octet-stream",
		);
		expect(result.success).toBe(true);
		const fetched = await service.downloadBytes("ignored", "u8.bin");
		expect(fetched.equals(Buffer.from(payload))).toBe(true);
	});

	it("exists returns true for written keys, false for unwritten", async () => {
		await service.uploadBytes(Buffer.from("hello"), "exists.txt", "text/plain");
		expect(await service.exists("ignored", "exists.txt")).toBe(true);
		expect(await service.exists("ignored", "missing.txt")).toBe(false);
	});

	it("delete removes a previously-stored object", async () => {
		await service.uploadBytes(
			Buffer.from("transient"),
			"doomed.txt",
			"text/plain",
		);
		expect(await service.exists("ignored", "doomed.txt")).toBe(true);
		await service.delete("ignored", "doomed.txt");
		expect(await service.exists("ignored", "doomed.txt")).toBe(false);
	});

	it("uploadFile copies a real temp file into storage", async () => {
		const sourcePath = path.join(workDir, "source.txt");
		await fsp.writeFile(sourcePath, "from disk");
		const result = await service.uploadFile(sourcePath, "uploads");
		expect(result.success).toBe(true);
		expect(result.url).toMatch(/^file:\/\/.+source\.txt$/);
		expect(result.url).toContain(`${storagePath}/uploads/`);
		const url = result.url ?? "";
		const writtenAt = url.replace(/^file:\/\//, "");
		const buf = await fsp.readFile(writtenAt);
		expect(buf.toString()).toBe("from disk");
	});

	it("uploadJson round-trips through downloadBytes", async () => {
		const result = await service.uploadJson(
			{ foo: "bar", n: 42, list: [1, 2, 3] },
			"data.json",
		);
		expect(result.success).toBe(true);
		expect(result.key).toBe("data.json");
		expect(result.url).toBe(`file://${path.join(storagePath, "data.json")}`);
		const buf = await service.downloadBytes("ignored", "data.json");
		expect(JSON.parse(buf.toString("utf8"))).toEqual({
			foo: "bar",
			n: 42,
			list: [1, 2, 3],
		});
	});

	it("downloadBytes throws when key is missing", async () => {
		await expect(
			service.downloadBytes("ignored", "no-such-key"),
		).rejects.toThrow(/not found/);
	});

	it("downloadFile writes the bytes to the requested local path", async () => {
		const payload = Buffer.from("download-me");
		await service.uploadBytes(
			payload,
			"to-download.bin",
			"application/octet-stream",
		);
		const target = path.join(workDir, "out.bin");
		await service.downloadFile("ignored", "to-download.bin", target);
		const buf = await fsp.readFile(target);
		expect(buf.equals(payload)).toBe(true);
	});

	it("generateSignedUrl returns a file:// absolute path under the storage root", async () => {
		const url = await service.generateSignedUrl("nested/dir/asset.png", 900);
		expect(url).toBe(
			`file://${path.join(storagePath, "nested/dir/asset.png")}`,
		);
	});
});

describe("storage root resolution", () => {
	it("falls back to LOCAL_STORAGE_PATH env when getSetting returns nothing", async () => {
		const altRoot = path.join(workDir, "from-env");
		process.env.LOCAL_STORAGE_PATH = altRoot;
		try {
			const runtime: FakeRuntime = {
				getSetting: () => undefined,
				getService: () => null,
			};
			const svc = (await LocalFileStorageService.start(
				runtime as unknown as Parameters<
					typeof LocalFileStorageService.start
				>[0],
			)) as LocalFileStorageService;
			expect(svc.root).toBe(path.resolve(altRoot));
			const stat = await fsp.stat(altRoot);
			expect(stat.isDirectory()).toBe(true);
			await svc.stop();
		} finally {
			delete process.env.LOCAL_STORAGE_PATH;
		}
	});

	it("derives a default path under ELIZA_STATE_DIR/attachments", async () => {
		const stateDir = path.join(workDir, "state");
		process.env.ELIZA_STATE_DIR = stateDir;
		delete process.env.LOCAL_STORAGE_PATH;
		try {
			const runtime: FakeRuntime = {
				getSetting: () => undefined,
				getService: () => null,
			};
			const svc = (await LocalFileStorageService.start(
				runtime as unknown as Parameters<
					typeof LocalFileStorageService.start
				>[0],
			)) as LocalFileStorageService;
			expect(svc.root).toBe(path.join(stateDir, "attachments"));
			await svc.stop();
		} finally {
			delete process.env.ELIZA_STATE_DIR;
		}
	});
});
