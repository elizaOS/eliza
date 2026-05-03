/**
 * Test Data Factories
 *
 * Shared constants and factory functions for generating test data.
 */

import { randomUUID } from "node:crypto";

/** A valid UUID that almost certainly doesn't exist in the DB */
export const NONEXISTENT_UUID = "00000000-0000-4000-8000-000000000000";

/** An obviously invalid UUID */
export const INVALID_UUID = "not-a-valid-uuid";

/** A UUID with trailing backslash (common production error) */
export const MALFORMED_UUID = "17c8b876-86a0-465d-9794-2aea244f4239\\";

/** Default agent ID used by the platform */
export const DEFAULT_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";

/** Generate a random UUID */
export function randomId(): string {
  return randomUUID();
}

/** Generate a test character payload */
export function testCharacter(overrides?: Record<string, unknown>) {
  return {
    name: `Test Agent ${Date.now()}`,
    bio: "A test agent for E2E testing",
    system: "You are a helpful test assistant.",
    topics: ["testing"],
    adjectives: ["helpful", "test"],
    ...overrides,
  };
}

/** Generate a test chat message payload */
export function testChatMessage(content = "Hello, test!") {
  return {
    messages: [{ role: "user", content }],
  };
}

/** Generate test API key name */
export function testApiKeyName(): string {
  return `test-key-${Date.now()}`;
}

/** Common HTTP status code sets for assertions */
export const STATUS = {
  /** Success or redirect */
  OK: [200, 201, 204, 301, 302, 304],
  /** Auth required */
  UNAUTHORIZED: [401, 403],
  /** Client error */
  CLIENT_ERROR: [400, 401, 403, 404, 409, 422, 429],
  /** Success with possible credit issues */
  SUCCESS_OR_PAYMENT: [200, 402],
} as const;
