/**
 * Unit test for the project registry — a real on-disk JSON store under a temp
 * ELIZA_STATE_DIR (no mocks). Covers upsert-by-localPath identity, active-project
 * selection, malformed-JSON rejection, and the legacy workspace-folder.json
 * synthesis path that keeps single-folder installs working without a write.
 */

import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getActiveProject,
	getProjectById,
	projectRegistryPath,
	readProjectRegistry,
	setActiveProject,
	upsertProject,
	writeProjectRegistry,
} from "./project-registry.ts";
import { writeWorkspaceFolderConfig } from "./workspace-folder-config.ts";

describe("project-registry", () => {
	let stateDir: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		stateDir = mkdtempSync(join(os.tmpdir(), "project-registry-"));
		env = { ELIZA_STATE_DIR: stateDir };
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("returns null when no registry and no legacy config exists", () => {
		expect(readProjectRegistry(env)).toBeNull();
		expect(getActiveProject(env)).toBeNull();
	});

	it("upserts a project keyed by localPath, preserving id/createdAt on re-upsert", () => {
		const first = upsertProject(
			{ name: "repo-a", localPath: "/tmp/repo-a" },
			env,
		);
		expect(first.id).toBeTruthy();
		expect(first.createdAt).toBe(first.lastOpenedAt);

		const second = upsertProject(
			{ name: "repo-a-renamed", localPath: "/tmp/repo-a", repoUrl: "git@x:a" },
			env,
		);
		expect(second.id).toBe(first.id);
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.name).toBe("repo-a-renamed");
		expect(second.repoUrl).toBe("git@x:a");

		const reg = readProjectRegistry(env);
		expect(reg?.projects).toHaveLength(1);
	});

	it("adds a distinct project for a distinct localPath", () => {
		upsertProject({ name: "a", localPath: "/tmp/a" }, env);
		upsertProject({ name: "b", localPath: "/tmp/b" }, env);
		expect(readProjectRegistry(env)?.projects).toHaveLength(2);
	});

	it("setActiveProject marks active and stamps lastOpenedAt; unknown id is a no-op returning null", () => {
		const p = upsertProject({ name: "a", localPath: "/tmp/a" }, env);
		expect(getActiveProject(env)).toBeNull();

		const active = setActiveProject(p.id, env);
		expect(active?.id).toBe(p.id);
		expect(getActiveProject(env)?.id).toBe(p.id);

		expect(setActiveProject("does-not-exist", env)).toBeNull();
		// still the previously-active project
		expect(getActiveProject(env)?.id).toBe(p.id);
	});

	it("getProjectById returns the record or null", () => {
		const p = upsertProject({ name: "a", localPath: "/tmp/a" }, env);
		// upsert canonicalizes localPath to an absolute path (resolve → realpath);
		// for a non-existent dir that is `resolve("/tmp/a")` — `/tmp/a` on POSIX,
		// `<drive>:\tmp\a` on Windows. Assert the platform-canonical form, not the
		// bare POSIX spelling, so the round-trip holds on every OS.
		expect(getProjectById(p.id, env)?.localPath).toBe(resolve("/tmp/a"));
		expect(getProjectById("nope", env)).toBeNull();
	});

	it("treats malformed JSON as absent (null), never a fabricated empty registry", () => {
		writeFileSync(projectRegistryPath(env), "{ not json", "utf8");
		expect(readProjectRegistry(env)).toBeNull();
	});

	it("rejects a registry whose version is not 1", () => {
		writeFileSync(
			projectRegistryPath(env),
			JSON.stringify({ version: 2, activeProjectId: null, projects: [] }),
			"utf8",
		);
		expect(readProjectRegistry(env)).toBeNull();
	});

	it("synthesizes an in-memory active project from legacy workspace-folder.json WITHOUT writing projects.json", () => {
		writeWorkspaceFolderConfig(
			{ path: "/tmp/legacy-folder", bookmark: "bm" },
			env,
		);

		const reg = readProjectRegistry(env);
		expect(reg?.projects).toHaveLength(1);
		expect(reg?.projects[0]?.localPath).toBe("/tmp/legacy-folder");
		expect(reg?.projects[0]?.bookmark).toBe("bm");
		expect(reg?.activeProjectId).toBe(reg?.projects[0]?.id);
		const projectId = reg?.projects[0]?.id;
		expect(readProjectRegistry(env)?.projects[0]?.id).toBe(projectId);
		expect(readProjectRegistry(env)?.activeProjectId).toBe(projectId);
		expect(getActiveProject(env)?.localPath).toBe("/tmp/legacy-folder");
		expect(getActiveProject(env)?.id).toBe(projectId);

		// No projects.json was written by the read.
		expect(() => readFileSync(projectRegistryPath(env), "utf8")).toThrow();

		const activated = setActiveProject(projectId ?? "", env);
		expect(activated?.id).toBe(projectId);
		expect(readProjectRegistry(env)?.activeProjectId).toBe(projectId);
	});

	it("synthesized legacy project keeps a stable id across reads and across the first real upsert", () => {
		writeWorkspaceFolderConfig(
			{ path: "/tmp/legacy-folder", bookmark: null },
			env,
		);

		// The synthesized registry is re-minted per read; the id must not change,
		// or a task bound during the migration window could never resolve its
		// project again (#13776 bound-workdir lock would silently no-op).
		const first = readProjectRegistry(env)?.projects[0]?.id;
		const second = readProjectRegistry(env)?.projects[0]?.id;
		expect(first).toBeTruthy();
		expect(second).toBe(first);

		// The first real write (upsert keyed by localPath) persists the SAME id,
		// so bindings minted during the migration window survive the switch to
		// projects.json.
		const persisted = upsertProject(
			{ name: "legacy-folder", localPath: "/tmp/legacy-folder" },
			env,
		);
		expect(persisted.id).toBe(first);
		// The upsert persists the canonical (resolve'd) localPath, which differs
		// from the bare POSIX spelling on Windows (`<drive>:\tmp\legacy-folder`).
		expect(getProjectById(persisted.id, env)?.localPath).toBe(
			resolve("/tmp/legacy-folder"),
		);
	});

	it("persists and preserves worldId across re-upsert", () => {
		const first = upsertProject(
			{ name: "a", localPath: "/tmp/world-a", worldId: "w-123" },
			env,
		);
		expect(first.worldId).toBe("w-123");
		// A re-upsert that omits worldId keeps the stored one, not undefined.
		const second = upsertProject({ name: "a", localPath: "/tmp/world-a" }, env);
		expect(second.worldId).toBe("w-123");
		expect(getProjectById(first.id, env)?.worldId).toBe("w-123");
	});

	it("canonicalizes localPath so a symlinked spelling upserts one project, not a duplicate", () => {
		// Real dir + a symlink pointing at it: both realpath to the same target, so
		// the second upsert must update the first record, never add a second.
		const realDir = mkdtempSync(join(os.tmpdir(), "project-real-"));
		const linkPath = join(stateDir, "link-to-real");
		symlinkSync(realDir, linkPath);
		try {
			const viaReal = upsertProject({ name: "r", localPath: realDir }, env);
			const viaLink = upsertProject({ name: "r2", localPath: linkPath }, env);
			expect(viaLink.id).toBe(viaReal.id);
			expect(readProjectRegistry(env)?.projects).toHaveLength(1);
			// Stored path is the canonical (realpath'd) target, not the symlink.
			expect(readProjectRegistry(env)?.projects[0]?.localPath).toBe(
				realpathSync(realDir),
			);
		} finally {
			rmSync(realDir, { recursive: true, force: true });
		}
	});

	it("refuses to overwrite a newer-schema projects.json (forward-compat downgrade clobber)", () => {
		// A future build wrote a v2 file with the user's projects. This build reads
		// it as null (isProjectRegistry rejects v2), so a naive upsert would replace
		// it with a fresh v1 — dropping every project. The write must throw instead.
		writeFileSync(
			projectRegistryPath(env),
			JSON.stringify({
				version: 2,
				activeProjectId: null,
				projects: [{ id: "keep-me" }],
			}),
			"utf8",
		);
		expect(() =>
			upsertProject({ name: "a", localPath: "/tmp/a" }, env),
		).toThrow(/refusing to overwrite/);
		// The v2 file is untouched.
		const onDisk = JSON.parse(readFileSync(projectRegistryPath(env), "utf8"));
		expect(onDisk.version).toBe(2);
		expect(onDisk.projects[0].id).toBe("keep-me");
	});

	it("writeProjectRegistry round-trips through disk", () => {
		writeProjectRegistry(
			{
				version: 1,
				activeProjectId: "p1",
				projects: [
					{
						id: "p1",
						name: "a",
						localPath: "/tmp/a",
						createdAt: "2026-01-01T00:00:00.000Z",
						lastOpenedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			},
			env,
		);
		const reg = readProjectRegistry(env);
		expect(reg?.activeProjectId).toBe("p1");
		expect(reg?.projects[0]?.name).toBe("a");
	});
});
