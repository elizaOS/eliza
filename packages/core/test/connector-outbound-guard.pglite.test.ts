/**
 * editMessageOnTarget and postToThreadOnTarget deliver agent text to a
 * connector just like sendMessageToTarget, so they must apply the same
 * outbound policy: the secret-swap reply redaction, the machine-syntax
 * sanitizer, and the fail-closed external-content envelope guard. The agent
 * orchestrator reroutes every non-internal send in a room with one active
 * sub-agent thread through postToThreadOnTarget and streams sub-agent
 * narration through both hooks.
 * Drives a real AgentRuntime on an in-memory PGlite database (plugin-sql).
 */

import pluginSql from "@elizaos/plugin-sql";
import { afterEach, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime";
import { wrapExternalContent } from "../src/security/external-content.ts";
import { ENVELOPE_LEAK_NOTICE } from "../src/security/outbound-envelope-guard.js";
import { SecretSwapSession } from "../src/security/secret-swap.ts";
import { runWithTrajectoryContext } from "../src/trajectory-context.ts";
import type { TargetInfo } from "../src/types/messaging.js";
import type { Content } from "../src/types/primitives.js";
import { stringToUuid } from "../src/utils/string-to-uuid.js";

let databases = 0;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createRuntime(): Promise<AgentRuntime> {
	const previousDataDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = `memory://connector-outbound-guard-${process.pid}-${++databases}`;
	const runtime = new AgentRuntime({
		character: { name: "OutboundGuard", bio: ["Tests outbound seams"] },
		logLevel: "fatal",
	});
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();
	cleanups.push(async () => {
		await runtime.stop();
		await runtime.close();
		if (previousDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
		else process.env.PGLITE_DATA_DIR = previousDataDir;
	});
	return runtime;
}

function registerRecordingConnector(runtime: AgentRuntime): {
	sent: Content[];
	edited: Content[];
	threaded: Content[];
} {
	const delivered = {
		sent: [] as Content[],
		edited: [] as Content[],
		threaded: [] as Content[],
	};
	runtime.registerMessageConnector({
		source: "discord",
		capabilities: ["send_message", "edit_message", "post_to_thread"],
		sendHandler: async (_runtime, _target, content) => {
			delivered.sent.push(content);
		},
		editHandler: async (_runtime, { content }) => {
			delivered.edited.push(content);
			return undefined;
		},
		postToThreadHandler: async (_runtime, { content }) => {
			delivered.threaded.push(content);
			return undefined;
		},
	});
	return delivered;
}

function targetFor(runtime: AgentRuntime): TargetInfo {
	return {
		source: "discord",
		roomId: stringToUuid(`${runtime.agentId}-outbound-guard-room`),
		channelId: "C0123",
	};
}

async function deliverEverywhere(
	runtime: AgentRuntime,
	target: TargetInfo,
	content: Content,
): Promise<void> {
	await runtime.sendMessageToTarget(target, content);
	await runtime.editMessageOnTarget(target, "m-1", content);
	await runtime.postToThreadOnTarget(target, { threadId: "T-1" }, content);
}

it("strips reasoning tags from edits and thread posts like a send", async () => {
	const runtime = await createRuntime();
	const delivered = registerRecordingConnector(runtime);

	await deliverEverywhere(runtime, targetFor(runtime), {
		text: "<think>the owner said not to tell Bob about the layoffs</think>Build finished.",
		agentVoiced: true,
	});

	expect(delivered.sent.map((c) => c.text)).toEqual(["Build finished."]);
	expect(delivered.edited.map((c) => c.text)).toEqual(["Build finished."]);
	expect(delivered.threaded.map((c) => c.text)).toEqual(["Build finished."]);
});

it("blocks an echoed external-content envelope on edits and thread posts", async () => {
	const runtime = await createRuntime();
	const delivered = registerRecordingConnector(runtime);
	const echoed = wrapExternalContent(
		"Hi, the wire for invoice 4471 goes out Friday.",
		{ source: "email", sender: "cfo@example.com", subject: "Invoice" },
	);

	await deliverEverywhere(runtime, targetFor(runtime), {
		text: `Here is what I found:\n${echoed}`,
		agentVoiced: true,
	});

	expect(delivered.sent.map((c) => c.text)).toEqual([ENVELOPE_LEAK_NOTICE]);
	expect(delivered.edited.map((c) => c.text)).toEqual([ENVELOPE_LEAK_NOTICE]);
	expect(delivered.threaded.map((c) => c.text)).toEqual([ENVELOPE_LEAK_NOTICE]);
	expect(
		runtime
			.getRecentReportedErrors()
			.filter((entry) => entry.scope === "outbound-envelope-guard")
			.map((entry) => entry.context?.seam),
	).toEqual([
		"sendMessageToTarget",
		"editMessageOnTarget",
		"postToThreadOnTarget",
	]);
});

it("redacts restored secret values from edits and thread posts like a send", async () => {
	const runtime = await createRuntime();
	const delivered = registerRecordingConnector(runtime);
	const secretSwapSession = new SecretSwapSession({
		knownSecrets: { DEPLOY_TOKEN: "dpl_4f9c2a7e81b34d6f" },
	});

	await runWithTrajectoryContext({ secretSwapSession }, () =>
		deliverEverywhere(runtime, targetFor(runtime), {
			text: "Deployed with dpl_4f9c2a7e81b34d6f.",
			agentVoiced: true,
		}),
	);

	const redacted = "Deployed with [redacted credential].";
	expect(delivered.sent.map((c) => c.text)).toEqual([redacted]);
	expect(delivered.edited.map((c) => c.text)).toEqual([redacted]);
	expect(delivered.threaded.map((c) => c.text)).toEqual([redacted]);
});

it("keeps clean edit and thread content untouched", async () => {
	const runtime = await createRuntime();
	const delivered = registerRecordingConnector(runtime);
	const target = targetFor(runtime);
	const content: Content = {
		text: "⏳ [build] Running `<think>` parser tests",
		source: "sub_agent_progress",
		metadata: { transient: true },
	};

	await runtime.editMessageOnTarget(target, "m-1", content);
	await runtime.postToThreadOnTarget(target, { threadId: "T-1" }, content);

	expect(delivered.edited).toEqual([content]);
	expect(delivered.threaded).toEqual([content]);
});
