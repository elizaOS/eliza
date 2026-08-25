/**
 * Unit + property tests (fast-check) for Matrix multi-account resolution
 * (`accounts.ts`) against an in-memory `getSetting` stub — no homeserver.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
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
  it("fails closed for malformed MATRIX_ACCOUNTS JSON", () => {
    const runtime = runtimeWithSettings({
      MATRIX_ACCOUNTS: "{not-json",
      MATRIX_HOMESERVER: "https://matrix.example",
      MATRIX_USER_ID: "@bot:example",
      MATRIX_ACCESS_TOKEN: " token ",
    });

    expect(() => listMatrixAccountIds(runtime)).toThrow(ElizaError);
    try {
      resolveDefaultMatrixAccountId(runtime);
      throw new Error("expected malformed MATRIX_ACCOUNTS to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("MATRIX_CONFIG_INVALID");
      expect((error as ElizaError).context).toEqual({
        setting: "MATRIX_ACCOUNTS",
      });
      expect((error as ElizaError).severity).toBe("fatal");
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
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

describe("resolveMatrixAccountSettings owner-bind fail-closed", () => {
  const ownerCharacter = {
    matrix: {
      homeserver: "https://owner.matrix",
      userId: "@owner:matrix",
      accessToken: "owner-access-token",
      password: "owner-password",
      deviceId: "OWNERDEVICE",
      rooms: ["!owner:matrix"],
    },
  };
  const ownerEnv = {
    MATRIX_HOMESERVER: "https://env.matrix",
    MATRIX_USER_ID: "@env:matrix",
    MATRIX_ACCESS_TOKEN: "env-access-token",
    MATRIX_PASSWORD: "env-password",
    MATRIX_DEVICE_ID: "ENVDEVICE",
  };

  it("lets the default account inherit owner character identity", () => {
    const runtime = runtimeWithSettings({}, ownerCharacter);
    const resolved = resolveMatrixAccountSettings(runtime, "default");
    expect(resolved.accountId).toBe("default");
    expect(resolved.homeserver).toBe("https://owner.matrix");
    expect(resolved.userId).toBe("@owner:matrix");
    expect(resolved.accessToken).toBe("owner-access-token");
    expect(resolved.password).toBe("owner-password");
    expect(resolved.deviceId).toBe("OWNERDEVICE");
  });

  it("does not give a ghost accountId the owner token, password, or homeserver", () => {
    const runtime = runtimeWithSettings({}, ownerCharacter);
    const ghost = resolveMatrixAccountSettings(runtime, "ghost-account");
    expect(ghost.accountId).toBe("ghost-account");
    expect(ghost.homeserver).toBe("");
    expect(ghost.userId).toBe("");
    expect(ghost.accessToken).toBe("");
    expect(ghost.password).toBeUndefined();
    expect(ghost.deviceId).toBeUndefined();
  });

  it("does not let a named account without its own token inherit character identity", () => {
    const runtime = runtimeWithSettings(
      {},
      { matrix: { ...ownerCharacter.matrix, accounts: { work: { enabled: true } } } }
    );
    const work = resolveMatrixAccountSettings(runtime, "work");
    expect(work.accountId).toBe("work");
    expect(work.homeserver).toBe("");
    expect(work.userId).toBe("");
    expect(work.accessToken).toBe("");
    expect(work.password).toBeUndefined();
    expect(work.deviceId).toBeUndefined();
  });

  it("keeps a named account own identity and does not attach owner character secrets", () => {
    const runtime = runtimeWithSettings(
      {},
      {
        matrix: {
          ...ownerCharacter.matrix,
          accounts: {
            work: {
              homeserver: "https://work.matrix",
              userId: "@work:matrix",
              accessToken: "work-access-token",
            },
          },
        },
      }
    );
    const work = resolveMatrixAccountSettings(runtime, "work");
    expect(work.homeserver).toBe("https://work.matrix");
    expect(work.userId).toBe("@work:matrix");
    expect(work.accessToken).toBe("work-access-token");
    expect(work.password).toBeUndefined();
    expect(work.deviceId).toBeUndefined();
  });

  it("does not give a ghost accountId owner env identity either", () => {
    const runtime = runtimeWithSettings(ownerEnv);
    const ghost = resolveMatrixAccountSettings(runtime, "ghost-account");
    expect(ghost.accessToken).toBe("");
    expect(ghost.password).toBeUndefined();
    expect(ghost.homeserver).toBe("");
    expect(ghost.userId).toBe("");
    const def = resolveMatrixAccountSettings(runtime, "default");
    expect(def.accessToken).toBe("env-access-token");
    expect(def.password).toBe("env-password");
    expect(def.homeserver).toBe("https://env.matrix");
  });
});
