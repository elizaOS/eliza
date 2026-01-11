/**
 * Unit tests for utility functions.
 */

import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { isValidJsonSpecification, validatePrompt } from "../../utils/validation";

const createMockMemory = (text: string): Memory =>
  ({
    id: crypto.randomUUID(),
    content: { text },
    userId: "test-user",
    roomId: "test-room",
    entityId: "test-entity",
    createdAt: Date.now(),
  }) as Memory;

describe("validatePrompt", () => {
  it("should return true for valid message", () => {
    const message = createMockMemory("Hello world");
    expect(validatePrompt(message)).toBe(true);
  });

  it("should return false for empty message", () => {
    const message = createMockMemory("");
    expect(validatePrompt(message)).toBe(false);
  });

  it("should return false for whitespace only message", () => {
    const message = createMockMemory("   ");
    expect(validatePrompt(message)).toBe(false);
  });

  it("should return false for null content", () => {
    const message = { content: null } as unknown as Memory;
    expect(validatePrompt(message)).toBe(false);
  });

  it("should return false for undefined message", () => {
    expect(validatePrompt(undefined as unknown as Memory)).toBe(false);
  });
});

describe("isValidJsonSpecification", () => {
  it("should return true for valid JSON", () => {
    const json = JSON.stringify({ name: "@test/plugin", description: "Test" });
    expect(isValidJsonSpecification(json)).toBe(true);
  });

  it("should return false for invalid JSON", () => {
    expect(isValidJsonSpecification("not json")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isValidJsonSpecification("")).toBe(false);
  });

  it("should return true for empty object", () => {
    expect(isValidJsonSpecification("{}")).toBe(true);
  });

  it("should return true for array", () => {
    expect(isValidJsonSpecification("[]")).toBe(true);
  });

  it("should return false for malformed JSON", () => {
    expect(isValidJsonSpecification('{"name": "test"')).toBe(false);
  });
});
