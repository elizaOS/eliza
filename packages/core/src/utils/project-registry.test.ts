/**
 * Unit test for the project registry — a real on-disk JSON store under a temp
 * ELIZA_STATE_DIR (no mocks). Covers upsert-by-localPath identity, active-project
 * selection, malformed-JSON rejection, and the legacy workspace-folder.json
 * synthesis path that keeps single-folder installs working without a write.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeWorkspaceFolderConfig } from "./workspace-folder-config.ts";
import {
	getActiveProject,
	getProjectById,
	projectRegistryPath,
	readProjectRegistry,
	setActiveProject,
	upsertProject,
	writeProjectRegistry,
} from "./project-registry.ts";

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
		expect(getProjectById(p.id, env)?.localPath).toBe("/tmp/a");
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
		expect(getActiveProject(env)?.localPath).toBe("/tmp/legacy-folder");

		// No projects.json was written by the read.
		expect(() => readFileSync(projectRegistryPath(env), "utf8")).toThrow();
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
