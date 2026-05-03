import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../../types";
import { validateActionKeywords, validateActionRegex } from "../keywords";

describe("validateActionKeywords", () => {
	const createMockMemory = (text: string, id: string = "1"): Memory => ({
		id: id as UUID,
		entityId: "user1" as UUID,
		roomId: "room1" as UUID,
		agentId: "agent1" as UUID,
		content: {
			text,
		},
		createdAt: Date.now(),
	});

	const mockMessage = createMockMemory("Hello world", "123");
	const mockRecentMessages: Memory[] = [
		createMockMemory("Previous message 1", "1"),
		createMockMemory("Previous message 2", "2"),
		createMockMemory("Crypto is cool", "3"),
		createMockMemory("Another message", "4"),
		createMockMemory("Last one", "5"),
	];

	it("should validate keyword in current message", () => {
		const msg = createMockMemory("I want to transfer sol");
		expect(validateActionKeywords(msg, [], ["transfer"])).toBe(true);
	});

	it("should validate keyword in recent messages", () => {
		expect(
			validateActionKeywords(mockMessage, mockRecentMessages, ["crypto"]),
		).toBe(true);
	});

	it("should return false when keyword not found", () => {
		expect(
			validateActionKeywords(mockMessage, mockRecentMessages, ["banana"]),
		).toBe(false);
	});

	it("should be case insensitive", () => {
		const msg = createMockMemory("I want to TRANSFER sol");
		expect(validateActionKeywords(msg, [], ["transfer"])).toBe(true);
	});

	it("should return false for empty keywords list", () => {
		expect(validateActionKeywords(mockMessage, mockRecentMessages, [])).toBe(
			false,
		);
	});

	it("should validate partial match", () => {
		const msg = createMockMemory("cryptography");
		expect(validateActionKeywords(msg, [], ["crypto"])).toBe(true);
	});

	it("should handle null or empty recent messages", () => {
		const msg = createMockMemory("transfer");
		expect(validateActionKeywords(msg, [], ["transfer"])).toBe(true);
		// @ts-expect-error
		expect(validateActionKeywords(msg, null, ["transfer"])).toBe(true);
	});
});

describe("validateActionRegex", () => {
	const createMockMemory = (text: string, id: string = "1"): Memory => ({
		id: id as UUID,
		entityId: "user1" as UUID,
		roomId: "room1" as UUID,
		agentId: "agent1" as UUID,
		content: {
			text,
		},
		createdAt: Date.now(),
	});

	const mockMessage = createMockMemory("Hello world", "123");
	const mockRecentMessages: Memory[] = [
		createMockMemory("Previous message 1", "1"),
		createMockMemory("Previous message 2", "2"),
		createMockMemory("Crypto is cool", "3"),
		createMockMemory("Another message", "4"),
		createMockMemory("Last one", "5"),
	];

	it("should validate regex in current message", () => {
		const msg = createMockMemory("Transfer 100 SOL");
		const regex = /transfer \d+ sol/i;
		expect(validateActionRegex(msg, [], regex)).toBe(true);
	});

	it("should validate regex in recent messages", () => {
		const regex = /crypto/i;
		expect(validateActionRegex(mockMessage, mockRecentMessages, regex)).toBe(
			true,
		);
	});

	it("should return false when regex does not match", () => {
		const regex = /banana/i;
		expect(validateActionRegex(mockMessage, mockRecentMessages, regex)).toBe(
			false,
		);
	});

	it("should handle complex regex", () => {
		const msg = createMockMemory("user@example.com");
		const regex = /^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/;
		expect(validateActionRegex(msg, [], regex)).toBe(true);
	});

	it("should return false for null regex", () => {
		// @ts-expect-error
		expect(validateActionRegex(mockMessage, mockRecentMessages, null)).toBe(
			false,
		);
	});
});
