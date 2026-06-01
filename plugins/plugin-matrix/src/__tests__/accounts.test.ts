import type { IAgentRuntime } from "@elizaos/core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MATRIX_ACCOUNT_ID,
  listMatrixAccountIds,
  normalizeMatrixAccountId,
  readMatrixAccountId,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccountSettings,
} from "../accounts.js";

function runtimeWithSettings(
  settings: Record<string, string | null | undefined>,
  characterSettings: Record<string, unknown> = {}
): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    character: { settings: characterSettings },
  } as unknown as IAgentRuntime;
}

describe("Matrix account settings", () => {
  it("ignores malformed MATRIX_ACCOUNTS JSON and falls back to single-account env settings", () => {
    const runtime = runtimeWithSettings({
      MATRIX_ACCOUNTS: "{not-json",
      MATRIX_HOMESERVER: "https://matrix.example",
      MATRIX_USER_ID: "@bot:example",
      MATRIX_ACCESS_TOKEN: " token ",
    });

    expect(listMatrixAccountIds(runtime)).toEqual([DEFAULT_MATRIX_ACCOUNT_ID]);
    expect(resolveDefaultMatrixAccountId(runtime)).toBe(DEFAULT_MATRIX_ACCOUNT_ID);
    expect(resolveMatrixAccountSettings(runtime)).toMatchObject({
      accountId: DEFAULT_MATRIX_ACCOUNT_ID,
      homeserver: "https://matrix.example",
      userId: "@bot:example",
      accessToken: "token",
    });
  });

  it("normalizes array account config IDs and ignores malformed entries", () => {
    const runtime = runtimeWithSettings({
      MATRIX_ACCOUNTS: JSON.stringify([
        { id: " work ", homeserver: "https://work", userId: "@work:example", accessToken: "w" },
        null,
        "bad",
        { accountId: "", homeserver: "https://fallback", userId: "@bot:example", accessToken: "d" },
      ]),
    });

    expect(listMatrixAccountIds(runtime)).toEqual(["default", "work"]);
    expect(resolveMatrixAccountSettings(runtime, "work")).toMatchObject({
      accountId: "work",
      homeserver: "https://work",
      userId: "@work:example",
      accessToken: "w",
    });
  });

  it("reads account IDs only from non-empty string fields across payload shapes", () => {
    expect(
      readMatrixAccountId(
        { accountId: " " },
        { parameters: { accountId: "\tpersonal\n" } },
        { data: { matrix: { accountId: "ignored" } } }
      )
    ).toBe("personal");

    expect(readMatrixAccountId({ data: { matrix: { accountId: " work " } } })).toBe("work");
    expect(readMatrixAccountId({ metadata: { accountId: 7 } })).toBeUndefined();
  });

  it("normalizes arbitrary account IDs without returning blanks", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 80 }), fc.integer(), fc.constant(null)), (id) => {
        const normalized = normalizeMatrixAccountId(id);
        expect(normalized).not.toBe("");
        if (typeof id === "string" && id.trim()) {
          expect(normalized).toBe(id.trim());
        } else {
          expect(normalized).toBe(DEFAULT_MATRIX_ACCOUNT_ID);
        }
      })
    );
  });
});
