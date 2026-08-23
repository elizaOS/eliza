/**
 * `mapToCharacter` composes an Eliza Character from an OpenClaw persona
 * source: name priority (IDENTITY "Name:" → leading SOUL H1 → capitalized
 * agentId), system assembly (SOUL spine + AGENTS operating rules + live
 * context), IDENTITY/SOUL-derived bio, Vibe-derived adjectives, playbook-
 * derived style.chat, and the USER-knowledge firewall with its settings
 * provenance note.
 *
 * Pure unit harness — drives the real exported mapper against literal
 * in-memory sources; no mocks and no filesystem access.
 */
import { describe, expect, it } from "vitest";

import { mapToCharacter } from "./character-mapper.js";
import type { OcAgentSource } from "./openclaw-reader.js";

function srcWith(overrides: Partial<OcAgentSource> = {}): OcAgentSource {
  return {
    agentId: "agent-x",
    home: "/nonexistent/home",
    dailyLogs: [],
    namedMemory: [],
    hasSecretsDir: false,
    sqliteStores: [],
    sqliteUningested: false,
    warnings: [],
    ...overrides,
  };
}

const FIREWALL_NOTE =
  "USER/personal knowledge excluded (firewalled) from this character.";

describe("mapToCharacter", () => {
  describe("name derivation", () => {
    it("prefers the IDENTITY 'Name:' line over the SOUL heading and agentId", () => {
      const c = mapToCharacter(
        srcWith({
          agentId: "totally-different-id",
          soul: "# Sol\nBody.",
          identity: "Name: Sol Prime\nMore identity prose.",
        }),
        { firewall: true },
      );
      expect(c.name).toBe("Sol Prime");
    });

    it('reads a bolded "**Name:**" line and strips the asterisks', () => {
      const c = mapToCharacter(
        srcWith({ identity: "**Name:** Nyx\n- calm demeanor" }),
        { firewall: true },
      );
      expect(c.name).toBe("Nyx");
    });

    it("reads a bulleted '- Name:' line including multi-word names verbatim", () => {
      const c = mapToCharacter(
        srcWith({ identity: "- Name: Vesper Nine\n- tall" }),
        { firewall: true },
      );
      expect(c.name).toBe("Vesper Nine");
    });

    it("falls back to a leading SOUL H1 and capitalizes a single-word title", () => {
      const c = mapToCharacter(
        srcWith({ agentId: "zzz-unrelated", soul: "# nyx\nBody." }),
        { firewall: true },
      );
      expect(c.name).toBe("Nyx");
    });

    it("ignores boilerplate SOUL titles and falls back to the capitalized agentId", () => {
      const c = mapToCharacter(
        srcWith({ agentId: "vesper", soul: "# SOUL\nBody text." }),
        { firewall: true },
      );
      expect(c.name).toBe("Vesper");
    });

    it("does not name the agent after a later heading when SOUL opens with prose", () => {
      const c = mapToCharacter(
        srcWith({
          agentId: "moss",
          soul: "Opening prose line that stands alone.\n\n# Voice\nNotes.",
        }),
        { firewall: true },
      );
      expect(c.name).toBe("Moss");
    });

    it("allows HTML comments and blank lines before the SOUL title", () => {
      const c = mapToCharacter(
        srcWith({ soul: "<!-- generated -->\n<!-- meta -->\n\n# kira\nBody." }),
        { firewall: true },
      );
      expect(c.name).toBe("Kira");
    });

    it("collapses an over-long multi-word SOUL title (>4 words) to its capitalized first word", () => {
      const c = mapToCharacter(
        srcWith({ soul: "# one two three four five\nBody." }),
        { firewall: true },
      );
      expect(c.name).toBe("One");
    });
  });

  describe("system prompt composition", () => {
    it("uses SOUL as the spine (front heading stripped) and appends AGENTS under the operating-rules marker", () => {
      const c = mapToCharacter(
        srcWith({
          soul: "# Sol\nI speak with warm precision.",
          agents: "# Rules\nAlways confirm before destructive actions.",
        }),
        { firewall: true },
      );
      expect(c.system).toBe(
        "I speak with warm precision.\n\n# Operating rules (from AGENTS.md)\nAlways confirm before destructive actions.",
      );
    });

    it("appends a trimmed live context last under the CURRENT CONTEXT marker", () => {
      const c = mapToCharacter(srcWith({ soul: "# Nyx\nQuiet by default." }), {
        firewall: true,
        currentContext: "  Focus: shipping the migration CLI.  ",
      });
      expect(c.system).toBe(
        "Quiet by default.\n\n[CURRENT CONTEXT - keep this live, it overrides static bio facts]\nFocus: shipping the migration CLI.",
      );
    });

    it("treats whitespace-only persona files as absent and emits the scaffold system line", () => {
      const c = mapToCharacter(
        srcWith({
          agentId: "echo",
          soul: "   ",
          agents: "  \n",
          user: " ",
        }),
        { firewall: false, currentContext: "   " },
      );
      expect(c.system).toBe("You are Echo, an AI agent migrated onto Eliza.");
      expect(c.knowledge).toBeUndefined();
      expect(c.settings).toEqual({});
    });
  });

  describe("bio derivation", () => {
    it("takes IDENTITY bullet lines of at least twelve characters and rejects shorter ones", () => {
      const c = mapToCharacter(
        srcWith({
          soul: "# Sol\nI speak with warm precision.",
          identity: [
            "- Voice is warm, precise, never fussy",
            "- Too short",
            "- Second acceptable bio bullet line",
          ].join("\n"),
        }),
        { firewall: true },
      );
      expect(c.bio).toEqual([
        "Voice is warm, precise, never fussy",
        "Second acceptable bio bullet line",
      ]);
    });

    it("falls back to SOUL prose lines over twenty characters, skipping headings, stars, and blanks", () => {
      const c = mapToCharacter(
        srcWith({
          soul: [
            "# nyx",
            "Nyx keeps a low profile online.",
            "Short line.",
            "* starts with a star so skipped",
            "## Section header skipped",
            "Fourth prose line clearly past the limit.",
            "Fifth prose line also clearly past twenty.",
          ].join("\n"),
        }),
        { firewall: true },
      );
      expect(c.bio).toEqual([
        "Nyx keeps a low profile online.",
        "Fourth prose line clearly past the limit.",
        "Fifth prose line also clearly past twenty.",
      ]);
    });

    it("emits the scaffold bio line when neither IDENTITY bullets nor SOUL prose exist", () => {
      const c = mapToCharacter(srcWith({ agentId: "orin" }), {
        firewall: true,
      });
      expect(c.bio).toEqual(["Orin - an AI agent migrated onto Eliza."]);
    });

    it("caps IDENTITY-derived bio at eight bullets", () => {
      const identity = Array.from(
        { length: 10 },
        (_, i) => `- bio bullet ${i + 1} with padding`,
      ).join("\n");
      const c = mapToCharacter(srcWith({ identity }), { firewall: true });
      expect(c.bio).toHaveLength(8);
      expect(c.bio?.[7]).toBe("bio bullet 8 with padding");
      expect(JSON.stringify(c)).not.toContain("bio bullet 9");
    });
  });

  describe("adjectives", () => {
    it("derives lowercased adjectives from the Vibe line across comma, semicolon, and period separators", () => {
      const c = mapToCharacter(
        srcWith({ identity: "Name: Sol\nVibe: Warm; Witty, Sharp. two words" }),
        { firewall: true },
      );
      expect(c.adjectives).toEqual(["warm", "witty", "sharp"]);
    });

    it("filters multi-word, one-character, and oversized candidates", () => {
      const c = mapToCharacter(
        srcWith({
          identity:
            "Vibe: two words, tiny, a, supersuperlongadjectiveoverthelimit",
        }),
        { firewall: true },
      );
      expect(c.adjectives).toEqual(["tiny"]);
    });

    it("caps adjectives at ten entries", () => {
      const c = mapToCharacter(
        srcWith({
          identity: "Vibe: aa, bb, cc, dd, ee, ff, gg, hh, ii, jj, kk, ll",
        }),
        { firewall: true },
      );
      expect(c.adjectives).toEqual([
        "aa",
        "bb",
        "cc",
        "dd",
        "ee",
        "ff",
        "gg",
        "hh",
        "ii",
        "jj",
      ]);
    });

    it("omits the adjectives key when IDENTITY carries no Vibe line", () => {
      const c = mapToCharacter(srcWith({ identity: "Name: Vesper\n- calm" }), {
        firewall: true,
      });
      expect(c.adjectives).toBeUndefined();
    });
  });

  describe("style.chat from playbooks", () => {
    it("collects playbook bullets from playbook keys, excludes non-playbook and self-journal files, and drops self-titled playbook keys", () => {
      const c = mapToCharacter(
        srcWith({
          namedMemory: [
            {
              key: "conversation-playbook",
              filename: "conversation-playbook.md",
              text: "# Play\n- mirror the user's energy in conversation\n- say hi",
            },
            {
              key: "channel-guide",
              filename: "channel-guide.md",
              text: "- keep Discord replies under three sentences",
            },
            {
              key: "thoughts",
              filename: "thoughts.md",
              text: "- private journal thought number nine",
            },
            {
              key: "project-notes",
              filename: "project-notes.md",
              text: "- project note that should not appear anywhere",
            },
            {
              key: "conversation-playbook-journal",
              filename: "conversation-playbook-journal.md",
              text: "- self journal line inside a playbook-named file",
            },
          ],
        }),
        { firewall: true },
      );
      expect(c.style?.chat).toEqual([
        "mirror the user's energy in conversation",
        "keep Discord replies under three sentences",
      ]);
      const flat = JSON.stringify(c);
      expect(flat).not.toContain("private journal thought");
      expect(flat).not.toContain("project note that should not appear");
      expect(flat).not.toContain("self journal line");
    });

    it("keeps only bullets whose body is between eight and one-hundred-forty characters", () => {
      const c = mapToCharacter(
        srcWith({
          namedMemory: [
            {
              key: "conversation-playbook",
              filename: "conversation-playbook.md",
              text: ["- exactly8", "- say hi", `- ${"y".repeat(150)}`].join(
                "\n",
              ),
            },
          ],
        }),
        { firewall: true },
      );
      expect(c.style?.chat).toEqual(["exactly8"]);
    });

    it("caps style.chat at twenty-four bullets", () => {
      const text = Array.from(
        { length: 30 },
        (_, i) => `- bullet ${i + 1} padded`,
      ).join("\n");
      const c = mapToCharacter(
        srcWith({
          namedMemory: [
            {
              key: "conversation-playbook",
              filename: "conversation-playbook.md",
              text,
            },
          ],
        }),
        { firewall: true },
      );
      expect(c.style?.chat).toHaveLength(24);
      expect(c.style?.chat?.[23]).toBe("bullet 24 padded");
      expect(JSON.stringify(c)).not.toContain("bullet 30 padded");
    });
  });

  describe("knowledge firewall", () => {
    it("excludes USER knowledge when firewalled and records the firewall note in settings", () => {
      const c = mapToCharacter(
        srcWith({
          user: "# About the human\nPrefers concise replies.",
        }),
        { firewall: true },
      );
      expect(c.knowledge).toBeUndefined();
      expect(c.settings?.firewall_note).toBe(FIREWALL_NOTE);
    });

    it("includes USER knowledge as inline text when the firewall is lifted and leaves settings clean", () => {
      const c = mapToCharacter(
        srcWith({
          user: "# About the human\nPrefers concise replies.",
        }),
        { firewall: false },
      );
      expect(c.knowledge).toEqual([
        { case: "text", value: { text: "Prefers concise replies." } },
      ]);
      expect(c.settings).toEqual({});
    });

    it("omits knowledge and the note entirely when there is no USER file and no firewall", () => {
      const c = mapToCharacter(srcWith(), { firewall: false });
      expect(c.knowledge).toBeUndefined();
      expect(c.settings).toEqual({});
    });
  });

  it("never maps TOOLS.md content into any character field", () => {
    const c = mapToCharacter(
      srcWith({
        tools: "TOOLS.md contents: API_KEY=sk-live-abc123",
        soul: "# Sol\nBody.",
      }),
      { firewall: false },
    );
    const flat = JSON.stringify(c);
    expect(flat).not.toContain("API_KEY");
    expect(flat).not.toContain("sk-live-abc123");
  });

  it("builds a complete scaffold character from an empty source", () => {
    const c = mapToCharacter(srcWith({ agentId: "ada" }), {
      firewall: true,
    });
    expect(c.name).toBe("Ada");
    expect(c.system).toBe("You are Ada, an AI agent migrated onto Eliza.");
    expect(c.bio).toEqual(["Ada - an AI agent migrated onto Eliza."]);
    expect(c.adjectives).toBeUndefined();
    expect(c.style).toBeUndefined();
    expect(c.knowledge).toBeUndefined();
    expect(c.settings).toEqual({ firewall_note: FIREWALL_NOTE });
  });
});
