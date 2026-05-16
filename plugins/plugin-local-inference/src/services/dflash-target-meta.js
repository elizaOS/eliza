import fs from "node:fs/promises";
import path from "node:path";
export function getDflashTargetMetaBlockReason(input) {
	if (!input || typeof input !== "object") return null;
	const meta = input;
	if (meta.publishEligible === false) return "target-meta is not publishable";
	if (meta.drafter?.matchesTargetCheckpoint === false) {
		return "drafter does not match the target checkpoint";
	}
	const provenance =
		typeof meta.drafter?.provenance === "string"
			? meta.drafter.provenance
			: "";
	if (provenance.includes("stamp-only")) return "drafter is stamp-only";
	const drafterSha =
		typeof meta.drafter?.sha256 === "string" ? meta.drafter.sha256 : null;
	const targetSha =
		typeof meta.targetText?.sha256 === "string"
			? meta.targetText.sha256
			: null;
	if (drafterSha && targetSha && drafterSha === targetSha) {
		return "drafter bytes match the target model";
	}
	return null;
}
async function readDflashTargetMeta(drafter) {
	try {
		const metaPath = path.join(path.dirname(drafter.path), "target-meta.json");
		const raw = await fs.readFile(metaPath, "utf8");
		return JSON.parse(raw);
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			err.code === "ENOENT"
		) {
			return null;
		}
		return { publishEligible: false };
	}
}
export async function getDflashDrafterBlockReason(drafter) {
	const meta = await readDflashTargetMeta(drafter);
	return getDflashTargetMetaBlockReason(meta);
}
