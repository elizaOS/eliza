/**
 * Delivery-selection coverage for ATTACHMENT action=read: which text ships to
 * the user versus what stays planner-facing in `data`. Deterministic harness —
 * a hand-rolled runtime stub captures the TEXT_SMALL call and returns a scripted
 * summary; no module mocks and no live model.
 *
 * Regression under test (observed live, trajectory tj-d29ff62e98fbb2): a bare
 * Discord link share routed to ATTACHMENT with addToClipboard=true, and the
 * clipboard-requested branch switched user-visible delivery to the planner
 * record dump — metadata envelope plus the full stored page — which shipped
 * verbatim as a ~13-message Discord wall. The user-visible text must always be
 * the prose answer unless the user explicitly asked for the attachment record.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import type {
	HandlerCallback,
	IAgentRuntime,
	Media,
	Memory,
	UUID,
} from "../../types/index.ts";
import { ContentType } from "../../types/index.ts";
import { readAttachmentAction } from "./readAttachmentAction.ts";

const PAGE_MARKER = "Store encrypted hourly backups of your entire Umbrel";
const STORED_PAGE = [
	"umbrelOS - An elegant OS for your home server",
	"",
	PAGE_MARKER,
	"",
	"Bitcoin Node Install Lightning Node mempool - LibreOffice - Sphinx Relay - Tailscale - Nextcloud - Firefox",
	"lorem ipsum ".repeat(400),
].join("\n");

const SUMMARY =
	"umbrelOS is a free self-hosted home-server OS with one-click apps like a Bitcoin node, Nextcloud, and Jellyfin.";

type ModelCall = { prompt: string; maxTokens: number };

function makeAttachment(): Media {
	return {
		id: "webpage-85b0602a68906762298056cf",
		url: "https://umbrel.com/umbrelos",
		title: "umbrelos",
		source: "Web",
		contentType: ContentType.LINK,
		text: STORED_PAGE,
	};
}

function makeRuntime(params: {
	modelResponse: string;
	calls: ModelCall[];
	agentId: UUID;
}): IAgentRuntime {
	const clipboardDir = mkdtempSync(path.join(tmpdir(), "attachment-clip-"));
	const runtime = {
		agentId: params.agentId,
		getConversationLength: () => 8,
		getMemories: async () => [],
		getRoom: async () => null,
		getWorld: async () => null,
		getService: () => null,
		getSetting: (key: string) =>
			key === "CLIPBOARD_BASE_PATH" ? clipboardDir : undefined,
		reportError: () => {},
		useModel: async (_type: unknown, options: unknown) => {
			const { prompt, maxTokens } = options as {
				prompt: string;
				maxTokens: number;
			};
			params.calls.push({ prompt, maxTokens });
			return params.modelResponse;
		},
	};
	return runtime as unknown as IAgentRuntime;
}

function makeMessage(params: { agentId: UUID; text: string }): Memory {
	return {
		id: uuidv4() as UUID,
		agentId: params.agentId,
		entityId: uuidv4() as UUID,
		roomId: uuidv4() as UUID,
		createdAt: Date.now(),
		content: {
			text: params.text,
			source: "discord",
			attachments: [makeAttachment()],
		},
	};
}

async function runRead(params: {
	modelResponse: string;
	text: string;
	handlerParams?: Record<string, unknown>;
}) {
	const agentId = uuidv4() as UUID;
	const calls: ModelCall[] = [];
	const runtime = makeRuntime({
		modelResponse: params.modelResponse,
		calls,
		agentId,
	});
	const message = makeMessage({ agentId, text: params.text });
	const callbackTexts: string[] = [];
	const callback: HandlerCallback = async (content) => {
		if (typeof content?.text === "string") callbackTexts.push(content.text);
		return [];
	};
	const result = await readAttachmentAction.handler?.(
		runtime,
		message,
		undefined,
		{ parameters: { action: "read", ...params.handlerParams } },
		callback,
	);
	return { result, callbackTexts, calls };
}

describe("ATTACHMENT read delivery selection", () => {
	it("bare link share with addToClipboard ships ONE prose summary, never the record dump", async () => {
		const { result, callbackTexts } = await runRead({
			modelResponse: SUMMARY,
			text: "remilio nubilio (@1490833425802854491) https://umbrel.com/umbrelos",
			handlerParams: {
				addToClipboard: true,
				attachmentId: "webpage-85b0602a68906762298056cf",
			},
		});

		expect(result?.success).toBe(true);
		// Exactly one message ships, and it is the authored summary.
		expect(callbackTexts).toEqual([SUMMARY]);
		expect(result?.userFacingText).toBe(SUMMARY);
		expect(result?.verifiedUserFacing).toBe(true);
		expect(result?.turnComplete).toBe(true);
		// No planner envelope and no raw page content in the user-visible text.
		for (const banned of ["Stored content", "ID: webpage-", PAGE_MARKER]) {
			expect(callbackTexts[0]).not.toContain(banned);
		}
		// Clipboard persistence still happened; the state is planner-facing.
		const clipboard = (result?.data as { clipboard?: { stored?: boolean } })
			?.clipboard;
		expect(clipboard?.stored).toBe(true);
	});

	it("keeps the fetched page as model context: prompt and data carry the stored content", async () => {
		const { result, calls } = await runRead({
			modelResponse: SUMMARY,
			text: "https://umbrel.com/umbrelos",
		});

		expect(calls).toHaveLength(1);
		// The model reads the page to author the summary...
		expect(calls[0]?.prompt).toContain(PAGE_MARKER);
		// ...under the bare-link one-take contract with a small budget.
		expect(calls[0]?.prompt).toContain(
			"Reply with ONE short take of at most two sentences",
		);
		expect(calls[0]?.maxTokens).toBe(256);
		// The planner keeps the full content in data.
		expect((result?.data as { content?: string })?.content).toContain(
			PAGE_MARKER,
		);
	});

	it("a real question next to the link answers the question, not a page take", async () => {
		const { calls } = await runRead({
			modelResponse: "It supports encrypted hourly backups.",
			text: "does umbrelOS support backups? see https://umbrel.com/umbrelos",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.prompt).not.toContain(
			"Reply with ONE short take of at most two sentences",
		);
		expect(calls[0]?.maxTokens).toBeGreaterThan(256);
	});

	it("a short non-ask remark next to the link still gets the one-take treatment", async () => {
		const { calls } = await runRead({
			modelResponse: SUMMARY,
			text: "check this out https://umbrel.com/umbrelos",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.prompt).toContain(
			"Reply with ONE short take of at most two sentences",
		);
		expect(calls[0]?.maxTokens).toBe(256);
	});

	it("an empty model response degrades to a short acknowledgement, never the raw page", async () => {
		const { callbackTexts } = await runRead({
			modelResponse: "",
			text: "https://umbrel.com/umbrelos",
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain('Read "umbrelos"');
		expect(callbackTexts[0]).not.toContain(PAGE_MARKER);
		expect(callbackTexts[0]).not.toContain("Stored content");
	});

	it("an explicit ask for the attachment record still gets the record", async () => {
		const { callbackTexts, calls } = await runRead({
			modelResponse: SUMMARY,
			text: "show me the attachment metadata for that link",
		});

		expect(calls).toHaveLength(0);
		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain("ID: webpage-85b0602a68906762298056cf");
		expect(callbackTexts[0]).toContain("Stored content: yes");
	});
});
