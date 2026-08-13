/**
 * Discover Agent Skills under skills/<skill-dir>/SKILL.md only (§6, §7.1).
 * Do not recurse. Skip any SKILL.md whose resolved path escapes the plugin root.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveredSkill } from "../types";
import { isDirectory, resolveContained } from "./paths";

export interface SkillDiscoveryResult {
	skills: DiscoveredSkill[];
	locationInvalid: boolean;
	warnings: string[];
}

export async function discoverSkills(
	pluginRoot: string,
): Promise<SkillDiscoveryResult> {
	const skillsRoot = join(pluginRoot, "skills");
	if (!(await isDirectory(skillsRoot))) {
		try {
			const { lstat } = await import("node:fs/promises");
			await lstat(skillsRoot);
			return {
				skills: [],
				locationInvalid: true,
				warnings: ["skills exists but is not a directory"],
			};
		} catch {
			return { skills: [], locationInvalid: false, warnings: [] };
		}
	}

	const contained = await resolveContained(pluginRoot, "./skills");
	if (!contained.ok) {
		return {
			skills: [],
			locationInvalid: true,
			warnings: [`skills/ escapes plugin root: ${contained.reason}`],
		};
	}

	const entries = await readdir(contained.path, { withFileTypes: true });
	const skills: DiscoveredSkill[] = [];
	const warnings: string[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (entry.isSymbolicLink()) {
			try {
				const dirStat = await stat(join(contained.path, entry.name));
				if (!dirStat.isDirectory()) continue;
			} catch {
				continue;
			}
		}

		const skillDir = join(contained.path, entry.name);
		const skillMd = join(skillDir, "SKILL.md");
		const mdContained = await resolveContained(pluginRoot, skillMd);
		if (!mdContained.ok) {
			warnings.push(
				`skipped skill "${entry.name}": SKILL.md escapes plugin root`,
			);
			continue;
		}
		try {
			const mdStat = await stat(mdContained.path);
			if (!mdStat.isFile()) continue;
		} catch {
			continue;
		}

		skills.push({
			directoryName: entry.name,
			skillDir,
			skillMdPath: mdContained.path,
		});
	}

	return { skills, locationInvalid: false, warnings };
}
