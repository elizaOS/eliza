// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    LocalLlamaError,
    loadLocalLlama,
    probeLocalLlama,
} from "../src/providers/local-llama.ts";

const tempDirs: string[] = [];
afterEach(() => {
    while (tempDirs.length > 0) {
        const d = tempDirs.pop();
        if (d !== undefined) rmSync(d, { recursive: true, force: true });
    }
    delete process.env.USBELIZA_LIBLLAMA_DIR;
    delete process.env.USBELIZA_LOCAL_BACKEND;
});

function workspace(): { libDir: string; modelsDir: string } {
    const libDir = mkdtempSync(join(tmpdir(), "usbeliza-libllama-"));
    const modelsDir = mkdtempSync(join(tmpdir(), "usbeliza-models-"));
    tempDirs.push(libDir, modelsDir);
    process.env.USBELIZA_LIBLLAMA_DIR = libDir;
    return { libDir, modelsDir };
}

function stageLibs(libDir: string) {
    writeFileSync(join(libDir, "libllama.so"), Buffer.alloc(16));
    writeFileSync(join(libDir, "libeliza-llama-shim.so"), Buffer.alloc(16));
}

function stageModel(modelsDir: string, ggufFilename: string, size = 8192) {
    // GGUF magic header (4 bytes) + padding so statSync says it's big enough.
    const buf = Buffer.alloc(size);
    buf.write("GGUF", 0, "ascii");
    writeFileSync(join(modelsDir, ggufFilename), buf);
}

describe("probeLocalLlama", () => {
    test("returns ready=false when libllama.so is missing", () => {
        const { modelsDir } = workspace();
        const probe = probeLocalLlama("eliza-1-0_8b", modelsDir);
        expect(probe.ready).toBe(false);
        expect(probe.reason).toContain("libllama.so not found");
    });

    test("returns ready=false when shim is missing", () => {
        const { libDir, modelsDir } = workspace();
        writeFileSync(join(libDir, "libllama.so"), Buffer.alloc(16));
        const probe = probeLocalLlama("eliza-1-0_8b", modelsDir);
        expect(probe.ready).toBe(false);
        expect(probe.reason).toContain("libeliza-llama-shim.so not found");
    });

    test("returns ready=false when model GGUF is missing", () => {
        const { libDir, modelsDir } = workspace();
        stageLibs(libDir);
        const probe = probeLocalLlama("eliza-1-0_8b", modelsDir);
        expect(probe.ready).toBe(false);
        expect(probe.reason).toContain("model GGUF missing");
    });

    test("returns ready=true when all artifacts present", () => {
        const { libDir, modelsDir } = workspace();
        stageLibs(libDir);
        stageModel(modelsDir, "eliza-1-0_8b-32k.gguf");
        const probe = probeLocalLlama("eliza-1-0_8b", modelsDir);
        expect(probe.ready).toBe(true);
        expect(probe.reason).toContain("eliza-1-0_8b");
    });

    test("forced=true when USBELIZA_LOCAL_BACKEND=llama", () => {
        const { modelsDir } = workspace();
        process.env.USBELIZA_LOCAL_BACKEND = "llama";
        const probe = probeLocalLlama("eliza-1-0_8b", modelsDir);
        expect(probe.forced).toBe(true);
    });

    test("returns ready=false for unknown model id", () => {
        const { libDir, modelsDir } = workspace();
        stageLibs(libDir);
        const probe = probeLocalLlama("totally-not-a-tier", modelsDir);
        expect(probe.ready).toBe(false);
        expect(probe.reason).toContain("not in catalog");
    });
});

describe("loadLocalLlama (FFI stub)", () => {
    test("throws missing-libllama when artifacts absent", () => {
        const { modelsDir } = workspace();
        let caught: unknown;
        try {
            loadLocalLlama("eliza-1-0_8b", modelsDir);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(LocalLlamaError);
        expect((caught as LocalLlamaError).code).toBe("missing-libllama");
    });

    test("throws missing-model for DFlash target without drafter on disk", () => {
        const { libDir, modelsDir } = workspace();
        stageLibs(libDir);
        stageModel(modelsDir, "eliza-1-9b-64k.gguf");
        // Did NOT stage the drafter — should fail.
        let caught: unknown;
        try {
            loadLocalLlama("eliza-1-9b", modelsDir);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(LocalLlamaError);
        expect((caught as LocalLlamaError).code).toBe("missing-model");
        expect((caught as Error).message).toContain("drafter");
    });

    test("throws not-implemented when all artifacts present (stub status)", () => {
        const { libDir, modelsDir } = workspace();
        stageLibs(libDir);
        stageModel(modelsDir, "eliza-1-0_8b-32k.gguf");
        let caught: unknown;
        try {
            loadLocalLlama("eliza-1-0_8b", modelsDir);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(LocalLlamaError);
        expect((caught as LocalLlamaError).code).toBe("not-implemented");
        expect((caught as Error).message).toContain("cross-compile");
    });

    test("throws load-failed when model file is too small to be GGUF", () => {
        const { libDir, modelsDir } = workspace();
        stageLibs(libDir);
        // 4 bytes — smaller than the GGUF header minimum.
        writeFileSync(
            join(modelsDir, "eliza-1-0_8b-32k.gguf"),
            Buffer.alloc(4),
        );
        let caught: unknown;
        try {
            loadLocalLlama("eliza-1-0_8b", modelsDir);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(LocalLlamaError);
        expect((caught as LocalLlamaError).code).toBe("load-failed");
    });
});
