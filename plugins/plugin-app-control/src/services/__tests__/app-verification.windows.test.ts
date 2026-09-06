import { rmSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { IAgentRuntime } from "@elizaos/core"
import { afterAll, describe, expect, it } from "vitest"
import { AppVerificationService } from "../app-verification.js"

const describeWindows = process.platform === "win32" ? describe : describe.skip

const noopRuntime = { getSetting: () => undefined } as unknown as IAgentRuntime

describeWindows("AppVerificationService Windows package-manager shims", () => {
	const stateDir = mkdtempSync(path.join(tmpdir(), "app-verify-windows-state-"))
	const previousStateDir = process.env.ELIZA_STATE_DIR
	process.env.ELIZA_STATE_DIR = stateDir
	const service = new AppVerificationService(noopRuntime)

	afterAll(async () => {
		await service.cleanup()
		rmSync(stateDir, { recursive: true, force: true })
		if (previousStateDir === undefined) {
			delete process.env.ELIZA_STATE_DIR
		} else {
			process.env.ELIZA_STATE_DIR = previousStateDir
		}
	})

	it("runs the real npm test check through the Windows shim", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "app-verify-windows-test-"))
		writeFileSync(
			path.join(workdir, "package.json"),
			JSON.stringify({
				name: "windows-shell-fixture",
				version: "0.0.0",
				private: true,
				scripts: { test: "node pass.mjs" },
			}),
			"utf8",
		)
		writeFileSync(
			path.join(workdir, "pass.mjs"),
			'process.stdout.write(" Tests  1 passed (1)\\n")\n',
			"utf8",
		)

		try {
			const result = await service.verifyProject({
				workdir,
				checks: [{ kind: "test" }],
				projectKind: "plugin",
				requireStructuredProof: false,
				runId: "windows-shell-test",
				packageManager: "npm",
			})

			expect(result.verdict).toBe("pass")
			expect(result.checks).toEqual([
				expect.objectContaining({ kind: "test", passed: true }),
			])
		} finally {
			rmSync(workdir, { recursive: true, force: true })
		}
	})
})
