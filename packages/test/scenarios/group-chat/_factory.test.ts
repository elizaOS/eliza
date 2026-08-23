/**
 * Verifies that timing scenarios carry the decision speaker as sender metadata
 * without placing a bracketed name in message text, which the runtime would
 * interpret as an addressee and suppress as a turn meant for someone else.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildGroupChatTimingSetup } from "./_factory.ts";
import silentScenario from "./groupchat.w2s.silent.ambient.001.scenario.ts";

describe("group-chat timing scenario factory", () => {
  it("keeps sender identity out of the decision text", () => {
    const setup = buildGroupChatTimingSetup({
      id: "test.timing.sender",
      title: "test",
      label: "speak",
      directlyAddressed: false,
      context: [{ speaker: "Speaker_0", text: "context" }],
      decisionTurn: { speaker: "Speaker_1", text: "open question" },
      sourceRow: "fixture",
    });

    expect(setup.decisionTurn.text).toBe("open question");
    expect(setup.decisionTurn.content).toEqual({ senderName: "Speaker_1" });
  });

  it("requires literal silence for a SILENT corpus label", () => {
    const turn = silentScenario.turns[0];
    if (turn?.kind !== "message" || !turn.assertResponse) {
      throw new Error("fixture must expose the SILENT response assertion");
    }

    expect(turn.assertResponse("")).toBeUndefined();
    expect(turn.assertResponse("👍")).toContain("expected no agent response");
  });

  it("keeps acceptance criteria visible in every generated scenario", () => {
    const domainDir = path.dirname(new URL(import.meta.url).pathname);
    const generatedFiles = [
      ...readdirSync(domainDir)
        .filter((name) => /^groupchat\.w2s\..*\.scenario\.ts$/.test(name))
        .map((name) => path.join(domainDir, name)),
      ...readdirSync(path.join(domainDir, "heldout", "ishiki"))
        .filter((name) => name.endsWith(".scenario.ts"))
        .map((name) => path.join(domainDir, "heldout", "ishiki", name)),
      ...readdirSync(path.join(domainDir, "behavior"))
        .filter((name) => name.endsWith(".scenario.ts"))
        .map((name) => path.join(domainDir, "behavior", name)),
    ];

    expect(generatedFiles.length).toBe(117);
    for (const file of generatedFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("assertResponse");
      expect(source, file).toMatch(/minimumScore|responseExcludes/);
    }
  });
});
