/**
 * Unit tests for serializing interaction blocks to bracket-marker wire forms.
 */

import { describe, expect, it } from "vitest";
import type {
	ChoiceInteraction,
	FollowupsInteraction,
	FormInteraction,
	SecretInteraction,
	TaskInteraction,
} from "../../types/interactions.js";
import {
	appendInteractionBlock,
	serializeInteractionBlock,
} from "./serialize.js";

describe("messaging interactions serialize", () => {
	it("serializes form interaction blocks", () => {
		const form: FormInteraction = {
			kind: "form",
			id: "form-123",
			title: "User Profile",
			description: "Enter your name and email",
			submitLabel: "Save",
			fields: [{ name: "name", label: "Full Name", type: "text" }],
		};

		const serialized = serializeInteractionBlock(form);
		expect(serialized.startsWith("[FORM]\n")).toBe(true);
		expect(serialized.endsWith("\n[/FORM]")).toBe(true);

		const jsonStr = serialized.replace("[FORM]\n", "").replace("\n[/FORM]", "");
		const parsed = JSON.parse(jsonStr);
		expect(parsed.id).toBe("form-123");
		expect(parsed.title).toBe("User Profile");
		expect(parsed.description).toBe("Enter your name and email");
		expect(parsed.submitLabel).toBe("Save");
		expect(parsed.fields).toHaveLength(1);
	});

	it("serializes choice interaction blocks with flags", () => {
		const choice: ChoiceInteraction = {
			kind: "choice",
			id: "choice-1",
			scope: "global",
			allowCustom: true,
			options: [
				{ label: "Option A", value: "opt_a" },
				{ label: "Option B", value: "opt_b" },
			],
		};

		const serialized = serializeInteractionBlock(choice);
		expect(serialized).toContain("[CHOICE:global id=choice-1 allow_custom]");
		expect(serialized).toContain("opt_a=Option A");
		expect(serialized).toContain("opt_b=Option B");
		expect(serialized).toContain("[/CHOICE]");
	});

	it("serializes followups interaction blocks", () => {
		const followups: FollowupsInteraction = {
			kind: "followups",
			id: "f-1",
			options: [
				{ kind: "reply", label: "Tell me more", payload: "more" },
				{ kind: "navigate", label: "Settings", payload: "/settings" },
			],
		};

		const serialized = serializeInteractionBlock(followups);
		expect(serialized).toContain("[FOLLOWUPS id=f-1]");
		expect(serialized).toContain("more=Tell me more");
		expect(serialized).toContain("navigate:/settings=Settings");
		expect(serialized).toContain("[/FOLLOWUPS]");
	});

	it("serializes task interaction blocks and returns empty for secret blocks", () => {
		const task: TaskInteraction = {
			kind: "task",
			threadId: "task-abc",
			title: "Index Codebase",
		};
		expect(serializeInteractionBlock(task)).toBe(
			"[TASK:task-abc]Index Codebase[/TASK]",
		);

		const secret: SecretInteraction = {
			kind: "secret",
			secretKind: "api_key",
			reason: "Need key",
		};
		expect(serializeInteractionBlock(secret)).toBe("");
	});

	it("appends interaction blocks to text", () => {
		const task: TaskInteraction = {
			kind: "task",
			threadId: "task-1",
			title: "Task 1",
		};

		expect(appendInteractionBlock("Hello", task)).toBe(
			"Hello\n\n[TASK:task-1]Task 1[/TASK]",
		);

		expect(appendInteractionBlock("", task)).toBe("[TASK:task-1]Task 1[/TASK]");

		const secret: SecretInteraction = {
			kind: "secret",
			secretKind: "api_key",
			reason: "Need key",
		};
		expect(appendInteractionBlock("Hello", secret)).toBe("Hello");
	});
});
