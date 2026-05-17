import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	isAppleSilicon,
	looksLikeMlxModelDir,
	MLX_BACKEND_ID,
	MlxLocalServer,
	mlxBackendEligible,
	mlxOptIn,
	resolveMlxModelDir,
} from "./mlx-server";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
	const prev: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		prev[k] = process.env[k];
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k];
	}
	try {
		fn();
	} finally {
		for (const k of Object.keys(prev)) {
			if (prev[k] === undefined) delete process.env[k];
			else process.env[k] = prev[k];
		}
	}
}

describe("mlx-server: opt-in + eligibility (in-process-only)", () => {
	it("MLX_BACKEND_ID is mlx-server", () => {
		expect(MLX_BACKEND_ID).toBe("mlx-server");
	});

	it("mlxOptIn is false unless ELIZA_LOCAL_MLX or ELIZA_LOCAL_BACKEND=mlx-server", () => {
		withEnv(
			{ ELIZA_LOCAL_MLX: undefined, ELIZA_LOCAL_BACKEND: undefined },
			() => {
				expect(mlxOptIn()).toBe(false);
			},
		);
		withEnv({ ELIZA_LOCAL_MLX: "1" }, () => {
			expect(mlxOptIn()).toBe(true);
		});
		withEnv(
			{ ELIZA_LOCAL_MLX: undefined, ELIZA_LOCAL_BACKEND: "mlx-server" },
			() => {
				expect(mlxOptIn()).toBe(true);
			},
		);
	});

	it("eligibility is false without the explicit opt-in", () => {
		withEnv(
			{ ELIZA_LOCAL_MLX: undefined, ELIZA_LOCAL_BACKEND: undefined },
			() => {
				const d = mlxBackendEligible();
				expect(d.eligible).toBe(false);
				expect(d.reason).toMatch(/opt-in/i);
			},
		);
	});

	it("eligibility refuses on non-Apple-Silicon hosts even when opted in", () => {
		if (isAppleSilicon()) return;
		withEnv({ ELIZA_LOCAL_MLX: "1" }, () => {
			const d = mlxBackendEligible();
			expect(d.eligible).toBe(false);
			expect(d.reason).toMatch(/Apple Silicon/i);
		});
	});

	it("eligibility is false on Apple Silicon too — no in-process runtime exists yet", () => {
		if (!isAppleSilicon()) return;
		withEnv({ ELIZA_LOCAL_MLX: "1" }, () => {
			const d = mlxBackendEligible();
			expect(d.eligible).toBe(false);
			expect(d.reason).toMatch(/in-process/i);
		});
	});

	it("looksLikeMlxModelDir wants config.json + a .safetensors, rejects gguf-only dirs", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mlx-test-"));
		try {
			expect(looksLikeMlxModelDir(tmp)).toBe(false);
			fs.writeFileSync(path.join(tmp, "config.json"), "{}");
			expect(looksLikeMlxModelDir(tmp)).toBe(false);
			fs.writeFileSync(path.join(tmp, "model.gguf"), "x");
			expect(looksLikeMlxModelDir(tmp)).toBe(false); // gguf is the llama.cpp path
			fs.writeFileSync(path.join(tmp, "model.safetensors"), "x");
			expect(looksLikeMlxModelDir(tmp)).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("resolveMlxModelDir honours ELIZA_MLX_MODEL_DIR when it points at a valid dir", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mlx-model-"));
		try {
			fs.writeFileSync(path.join(tmp, "config.json"), "{}");
			fs.writeFileSync(path.join(tmp, "model.safetensors"), "x");
			withEnv({ ELIZA_MLX_MODEL_DIR: tmp }, () => {
				expect(resolveMlxModelDir()).toBe(tmp);
			});
			withEnv({ ELIZA_MLX_MODEL_DIR: path.join(tmp, "nope") }, () => {
				const r = resolveMlxModelDir();
				expect(r === null || r === tmp).toBe(true);
			});
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("MlxLocalServer: in-process stub (no subprocess, no HTTP)", () => {
	it("hasLoadedModel is permanently false", () => {
		const t = new MlxLocalServer();
		expect(t.hasLoadedModel()).toBe(false);
		expect(t.currentModelPath()).toBeNull();
		expect(t.status()).toEqual({
			running: false,
			baseUrl: null,
			modelDir: null,
			pid: null,
		});
	});

	it("load() throws and names the unblock-plan doc", async () => {
		const t = new MlxLocalServer();
		await expect(t.load({ modelDir: "/fake/mlx/model" })).rejects.toThrow(
			/in-process MLX runtime is not implemented/i,
		);
	});

	it("generate() throws when there is no runtime", async () => {
		const t = new MlxLocalServer();
		await expect(t.generate({ prompt: "hi" })).rejects.toThrow(
			/no in-process MLX runtime/i,
		);
	});

	it("unload() is a no-op and resolves", async () => {
		const t = new MlxLocalServer();
		await expect(t.unload()).resolves.toBeUndefined();
	});
});
