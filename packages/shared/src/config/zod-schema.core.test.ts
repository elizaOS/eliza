/**
 * Tests for the shared core config schemas: accepted and rejected shapes,
 * strict-object rejection of unknown keys, exec-safety gating of command
 * heads, hex color validation, and the allowFrom normalization helpers.
 */

import { describe, expect, it } from "vitest";
import z from "zod";
import {
  DmConfigSchema,
  GroupChatSchema,
  HexColorSchema,
  ModelApiSchema,
  ModelCompatSchema,
  ModelDefinitionSchema,
  ModelsConfigSchema,
  normalizeAllowFrom,
  QueueModeSchema,
  requireOpenAllowFrom,
  TranscribeAudioSchema,
} from "./zod-schema.core.ts";

const OPEN_ALLOW_FROM_MESSAGE = "open policy requires allowFrom to include *";

const OpenAllowFromProbeSchema = z
  .object({
    policy: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message: OPEN_ALLOW_FROM_MESSAGE,
    });
  });

describe("ModelApiSchema", () => {
  it("accepts every supported provider API literal", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
      "bedrock-converse-stream",
    ]) {
      expect(ModelApiSchema.safeParse(api).success).toBe(true);
    }
  });

  it("rejects unknown API names and non-string values", () => {
    expect(ModelApiSchema.safeParse("openai-chat").success).toBe(false);
    expect(ModelApiSchema.safeParse(42).success).toBe(false);
    expect(ModelApiSchema.safeParse(undefined).success).toBe(false);
  });
});

describe("model definition schemas", () => {
  it("requires non-empty id and name on model definitions", () => {
    expect(
      ModelDefinitionSchema.safeParse({ id: "gpt-x", name: "GPT X" }).success,
    ).toBe(true);
    expect(ModelDefinitionSchema.safeParse({ name: "GPT X" }).success).toBe(
      false,
    );
    expect(
      ModelDefinitionSchema.safeParse({ id: "", name: "GPT X" }).success,
    ).toBe(false);
  });

  it("rejects unknown keys on strict objects", () => {
    expect(
      ModelCompatSchema.safeParse({ supportsStore: true, rogue: true }).success,
    ).toBe(false);
    expect(
      ModelDefinitionSchema.safeParse({
        id: "gpt-x",
        name: "GPT X",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("keeps optional compat blocks absent when omitted", () => {
    expect(ModelCompatSchema.parse(undefined)).toBeUndefined();
  });

  it("validates dependency-light input without materializing runtime defaults", () => {
    expect(ModelDefinitionSchema.parse({ id: "gpt-x", name: "GPT X" })).toEqual(
      {
        id: "gpt-x",
        name: "GPT X",
      },
    );
    expect(
      ModelDefinitionSchema.safeParse({
        id: "gpt-x",
        name: "GPT X",
        cost: { input: -1 },
      }).success,
    ).toBe(false);
    expect(
      ModelDefinitionSchema.safeParse({
        id: "gpt-x",
        name: "GPT X",
        contextWindow: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe("queue and chat config schemas", () => {
  it("accepts exactly the documented queue modes", () => {
    for (const mode of [
      "steer",
      "followup",
      "collect",
      "steer-backlog",
      "steer+backlog",
      "queue",
      "interrupt",
    ]) {
      expect(QueueModeSchema.safeParse(mode).success).toBe(true);
    }
    expect(QueueModeSchema.safeParse("random").success).toBe(false);
  });

  it("enforces differing history limit floors for dm and group chat", () => {
    expect(DmConfigSchema.safeParse({ historyLimit: 0 }).success).toBe(true);
    expect(DmConfigSchema.safeParse({ historyLimit: -1 }).success).toBe(false);
    expect(GroupChatSchema.safeParse({ historyLimit: 0 }).success).toBe(false);
    expect(GroupChatSchema.safeParse({ historyLimit: 5 }).success).toBe(true);
    expect(GroupChatSchema.safeParse({ historyLimit: 2.5 }).success).toBe(
      false,
    );
  });
});

describe("ModelsConfigSchema", () => {
  it("validates bedrock discovery integer bounds", () => {
    expect(
      ModelsConfigSchema.safeParse({
        bedrockDiscovery: { refreshInterval: 60 },
      }).success,
    ).toBe(true);
    expect(
      ModelsConfigSchema.safeParse({
        bedrockDiscovery: { refreshInterval: -1 },
      }).success,
    ).toBe(false);
    expect(
      ModelsConfigSchema.safeParse({
        bedrockDiscovery: { defaultMaxTokens: 0 },
      }).success,
    ).toBe(false);
  });

  it("restricts merge mode literals and rejects unknown keys", () => {
    expect(ModelsConfigSchema.safeParse({ mode: "merge" }).success).toBe(true);
    expect(ModelsConfigSchema.safeParse({ mode: "append" }).success).toBe(
      false,
    );
    expect(ModelsConfigSchema.safeParse({ rogue: 1 }).success).toBe(false);
  });
});

describe("TranscribeAudioSchema", () => {
  it("accepts bare executable names and filesystem paths as the command head", () => {
    expect(
      TranscribeAudioSchema.safeParse({ command: ["ffmpeg"] }).success,
    ).toBe(true);
    expect(
      TranscribeAudioSchema.safeParse({
        command: ["/usr/local/bin/whisper", "--model", "base"],
      }).success,
    ).toBe(true);
    expect(
      TranscribeAudioSchema.safeParse({ command: ["./tools/stt.sh"] }).success,
    ).toBe(true);
  });

  it("reports an exec-safety issue at path 0 for unsafe command heads", () => {
    for (const head of ["echo hi", "-flag", "a;b", "$(whoami)"]) {
      const result = TranscribeAudioSchema.safeParse({ command: [head] });
      if (result.success) {
        throw new Error(`expected "${head}" to be rejected`);
      }
      const issue = result.error.issues.find(
        (candidate) =>
          candidate.path[0] === "command" &&
          candidate.path[1] === 0 &&
          candidate.message === "expected safe executable name or path",
      );
      expect(
        issue,
        `expected an exec-safety issue for "${head}"`,
      ).toBeDefined();
    }
  });

  it("rejects an empty command array because the head is missing", () => {
    const result = TranscribeAudioSchema.safeParse({ command: [] });
    expect(result.success).toBe(false);
  });

  it("bounds timeoutSeconds to positive integers and rejects unknown keys", () => {
    expect(
      TranscribeAudioSchema.safeParse({
        command: ["ffmpeg"],
        timeoutSeconds: 30,
      }).success,
    ).toBe(true);
    expect(
      TranscribeAudioSchema.safeParse({
        command: ["ffmpeg"],
        timeoutSeconds: 0,
      }).success,
    ).toBe(false);
    expect(
      TranscribeAudioSchema.safeParse({ command: ["ffmpeg"], rogue: true })
        .success,
    ).toBe(false);
  });
});

describe("HexColorSchema", () => {
  it("accepts six-digit hex colors with or without the # prefix", () => {
    expect(HexColorSchema.parse("#ff00aa")).toBe("#ff00aa");
    expect(HexColorSchema.parse("FF00AA")).toBe("FF00AA");
  });

  it("rejects malformed colors", () => {
    expect(HexColorSchema.safeParse("ff00a").success).toBe(false);
    expect(HexColorSchema.safeParse("#ff00aa1").success).toBe(false);
    expect(HexColorSchema.safeParse("blue").success).toBe(false);
    expect(HexColorSchema.safeParse("##ff00aa").success).toBe(false);
  });
});

describe("normalizeAllowFrom", () => {
  it("returns an empty array for absent input", () => {
    expect(normalizeAllowFrom()).toEqual([]);
    expect(normalizeAllowFrom([])).toEqual([]);
  });

  it("trims strings, stringifies numbers, and drops empty entries", () => {
    expect(normalizeAllowFrom(["  alice ", "bob", ""])).toEqual([
      "alice",
      "bob",
    ]);
    expect(normalizeAllowFrom([42, 0])).toEqual(["42", "0"]);
  });
});

describe("requireOpenAllowFrom", () => {
  it("does not require * unless policy is exactly open", () => {
    expect(
      OpenAllowFromProbeSchema.safeParse({ policy: "allowlist" }).success,
    ).toBe(true);
    expect(
      OpenAllowFromProbeSchema.safeParse({ policy: "Open", allowFrom: [] })
        .success,
    ).toBe(true);
    expect(OpenAllowFromProbeSchema.safeParse({}).success).toBe(true);
  });

  it("accepts open policy when the normalized allowlist includes *", () => {
    expect(
      OpenAllowFromProbeSchema.safeParse({ policy: "open", allowFrom: ["*"] })
        .success,
    ).toBe(true);
    expect(
      OpenAllowFromProbeSchema.safeParse({
        policy: "open",
        allowFrom: ["  *  ", "ada"],
      }).success,
    ).toBe(true);
  });

  it("rejects open policy when * is missing after normalization", () => {
    for (const allowFrom of [undefined, [], ["ada"], ["", "  "], [42]]) {
      const failed = OpenAllowFromProbeSchema.safeParse({
        policy: "open",
        allowFrom,
      });
      expect(failed.success).toBe(false);
      if (!failed.success) {
        expect(failed.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ["allowFrom"],
              message: OPEN_ALLOW_FROM_MESSAGE,
            }),
          ]),
        );
      }
    }
  });
});
