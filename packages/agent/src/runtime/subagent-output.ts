/**
 * Subagent output helpers for delivering final task output to the originating
 * chat channel.
 *
 * The swarm synthesis path uses `completionSummary` (a short LLM-generated
 * description of what the agent did). For user-facing replies we want the
 * subagent's actual answer — the last `stop_reason: end_turn` assistant
 * message from the Claude Code session jsonl. This module reads that and
 * provides Discord-safe chunking.
 *
 * Path encoding mirrors Claude Code: `/home/milady/.milady/workspaces/abc`
 * becomes `-home-milady--milady-workspaces-abc` (every `/` and `.` maps to
 * `-`; the sequence `/.` produces `--`).
 *
 * @module runtime/subagent-output
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read the latest `stop_reason: end_turn` assistant text from the Claude Code
 * session jsonl under a subagent's workdir. Returns null when no such line
 * exists yet (still running, crashed before responding, or wrong workdir).
 */
export async function readLastAssistantTextFromJsonl(
	workdir: string,
): Promise<string | null> {
	const jsonlPath = await findLatestJsonl(workdir);
	if (!jsonlPath) return null;
	let content: string;
	try {
		content = await fs.readFile(jsonlPath, "utf-8");
	} catch {
		return null;
	}
	return findLatestEndTurnText(content);
}

/**
 * Locate the newest `.jsonl` file under Claude Code's project directory for
 * the given workdir.
 */
export async function findLatestJsonl(workdir: string): Promise<string | null> {
	const projectKey = workdir.replace(/[/.]/g, "-");
	const projectDir = join(homedir(), ".claude", "projects", projectKey);
	let entries: string[];
	try {
		entries = await fs.readdir(projectDir);
	} catch {
		return null;
	}
	const jsonls = entries.filter((f) => f.endsWith(".jsonl")).sort();
	if (jsonls.length === 0) return null;
	return join(projectDir, jsonls[jsonls.length - 1]);
}

/**
 * Scan jsonl text tail-first for the latest assistant message with
 * `stop_reason: end_turn` and return its text. Returns null if the latest
 * assistant line is still in a tool_use turn or no assistant line exists.
 */
export function findLatestEndTurnText(content: string): string | null {
	const lines = content.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let parsed: {
			message?: {
				role?: string;
				stop_reason?: string;
				content?: Array<{ type?: string; text?: string }>;
			};
		};
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = parsed.message;
		if (!msg || msg.role !== "assistant") continue;
		if (msg.stop_reason !== "end_turn") return null;
		let text = "";
		for (const c of msg.content ?? []) {
			if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
				text = c.text.trim();
			}
		}
		return text || null;
	}
	return null;
}

/**
 * Split text into Discord-safe chunks (≤ max chars each), preferring
 * paragraph → line → word boundaries past the halfway mark. Callers should
 * pass 1900 to leave headroom under Discord's 2000-char per-message limit.
 */
export function chunkForDiscord(text: string, max: number): string[] {
	if (text.length <= max) return [text];
	const out: string[] = [];
	let remaining = text;
	while (remaining.length > max) {
		const half = Math.floor(max / 2);
		let cut = remaining.lastIndexOf("\n\n", max);
		if (cut < half) cut = remaining.lastIndexOf("\n", max);
		if (cut < half) cut = remaining.lastIndexOf(" ", max);
		if (cut < half) cut = max;
		out.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	if (remaining) out.push(remaining);
	return out;
}
