/**
 * Tests for the ambiguity-safe app resolver (matchAppByReference / findAppByReference / resolveApp): id then exact name/slug then whole-word then fragment; ties are ambiguous. Pure, no SDK — plus the security-envelope adversarial suite proving the resolver can never see warning text.
 */
import { describe, expect, it } from "bun:test";
import type { Memory } from "@elizaos/core";
import { hardenIncomingUserMessage, wrapExternalContent } from "@elizaos/core";
import {
  appReferenceLogView,
  describeAppReference,
  extractAppReference,
  findAppByReference,
  matchAppByReference,
} from "../src/client.ts";
import { makeApp, makeMessage } from "./helpers";

const app = (name: string, id?: string) =>
  makeApp({
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    id: id ?? `id-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  });

describe("matchAppByReference / findAppByReference — ambiguity-safe resolution", () => {
  it("resolves an exact name uniquely", () => {
    const apps = [app("Prod API"), app("Prod API Backup")];
    expect(findAppByReference(apps, "Prod API")?.name).toBe("Prod API");
    expect(findAppByReference(apps, "prod api backup")?.name).toBe(
      "Prod API Backup",
    );
  });

  it("REGRESSION: a sentence naming the longer app resolves to it, not its prefix sibling", () => {
    // Prefix siblings are dangerous for destructive confirms: the sentence must
    // bind to the full named app, not the first shorter substring match.
    const apps = [app("Prod API"), app("Prod API Backup")]; // "Prod API" is first
    expect(
      matchAppByReference(apps, "delete Prod API Backup — yes").app?.name,
    ).toBe("Prod API Backup");
  });

  it("REGRESSION: word boundary — 'chatbot' does not resolve to an app named 'Bot'", () => {
    const apps = [app("Bot"), app("Chatbot Helper")];
    expect(
      matchAppByReference(apps, "delete my chatbot helper — yes").app?.name,
    ).toBe("Chatbot Helper");
  });

  it("REGRESSION: a fragment matching several apps is AMBIGUOUS (never silently apps[0])", () => {
    const apps = [app("Acme Bot"), app("Acme Helper")]; // both contain "acme"
    const m = matchAppByReference(apps, "acme");
    expect(m.app).toBeNull();
    expect(m.candidates.map((a) => a.name).sort()).toEqual([
      "Acme Bot",
      "Acme Helper",
    ]);
    // Back-compat single resolver returns null (not the first candidate).
    expect(findAppByReference(apps, "acme")).toBeNull();
  });

  it("resolves a unique fragment", () => {
    const apps = [app("Acme Bot"), app("Zenith")];
    expect(findAppByReference(apps, "acme")?.name).toBe("Acme Bot");
  });

  it("resolves an exact id directly", () => {
    const apps = [app("Prod API", "11111111-1111-4111-8111-111111111111")];
    expect(
      findAppByReference(apps, "11111111-1111-4111-8111-111111111111")?.name,
    ).toBe("Prod API");
  });

  it("returns null + no candidates when nothing matches", () => {
    const m = matchAppByReference([app("Acme Bot")], "unrelated zzz query");
    expect(m.app).toBeNull();
    expect(m.candidates).toEqual([]);
  });

  it("returns null for an empty reference", () => {
    expect(findAppByReference([app("Acme")], "   ")).toBeNull();
  });
});

describe("extractAppReference — planner options (nested `parameters` first)", () => {
  const msg = makeMessage("do something with my app");

  it("REGRESSION: reads the real planner shape — args nested under options.parameters", () => {
    // execute-planned-tool-call.ts puts validated args at options.parameters;
    // falling back to raw text can lose the planner's resolved app reference.
    expect(
      extractAppReference(msg, { parameters: { appName: "Acme Bot" } }),
    ).toBe("Acme Bot");
    expect(extractAppReference(msg, { parameters: { app: "Acme Bot" } })).toBe(
      "Acme Bot",
    );
    expect(extractAppReference(msg, { parameters: { appId: "id-acme" } })).toBe(
      "id-acme",
    );
  });

  it("nested planner args win over top-level keys", () => {
    expect(
      extractAppReference(msg, {
        appName: "Top Level",
        parameters: { appName: "Nested" },
      }),
    ).toBe("Nested");
  });

  it("still reads top-level options (direct handler calls)", () => {
    expect(extractAppReference(msg, { appName: "Acme Bot" })).toBe("Acme Bot");
  });

  it("falls back to top-level when parameters carries no reference", () => {
    expect(
      extractAppReference(msg, { appName: "Acme Bot", parameters: {} }),
    ).toBe("Acme Bot");
  });

  it("falls back to the message text when options carry no reference", () => {
    expect(extractAppReference(msg, { parameters: {} })).toBe(
      "do something with my app",
    );
    expect(extractAppReference(msg)).toBe("do something with my app");
  });
});

describe("extractAppReference — the resolver never sees security-warning text", () => {
  // The scenario shaw named: cloud apps whose NAMES collide with words in the
  // injected security warning. If armor text ever reaches the matcher, these
  // apps get selected/mutated by the warning itself.
  const collisionApps = [app("External Content"), app("Security"), app("Blog")];

  /** A message as core leaves it TODAY: wrapped text + retained payload. */
  function hardenedMessage(userSentence: string): Memory {
    const message = {
      entityId: "user-1",
      roomId: "room-1",
      content: { text: userSentence, source: "discord" },
    } as unknown as Memory;
    hardenIncomingUserMessage(message);
    return message;
  }

  /** A legacy persisted message: wrapped text + stamp, NO retained payload. */
  function legacyMessage(text: string): Memory {
    return {
      entityId: "user-1",
      roomId: "room-1",
      content: {
        text,
        source: "discord",
        metadata: { externalContentWrapped: true },
      },
    } as unknown as Memory;
  }

  it("HAZARD DEMO: armor text fed directly to the matcher selects a collision app", () => {
    // Documents why the fallback contract matters: "SECURITY NOTICE" in the
    // warning whole-word-matches an app named "Security", so the pre-fix
    // raw-text fallback let the injected warning pick the mutation target.
    const armor = wrapExternalContent("hi", {
      source: "api",
      includeWarning: true,
    });
    const hit = matchAppByReference(collisionApps, armor);
    expect(hit.app?.name).toBe("Security");
  });

  it("fresh hardened message: resolves from the retained payload, not the warning", () => {
    const message = hardenedMessage("delete the Blog app");
    expect((message.content.text as string).startsWith("SECURITY NOTICE")).toBe(
      true,
    );
    const reference = extractAppReference(message, { parameters: {} });
    expect(reference).toBe("delete the Blog app");
    expect(matchAppByReference(collisionApps, reference).app?.name).toBe(
      "Blog",
    );
  });

  it("legacy parseable envelope: resolves from the extracted payload only", () => {
    const wrapped = wrapExternalContent("delete the Blog app", {
      source: "api",
      includeWarning: true,
    });
    const reference = extractAppReference(legacyMessage(wrapped));
    expect(reference).toBe("delete the Blog app");
    expect(matchAppByReference(collisionApps, reference).app?.name).toBe(
      "Blog",
    );
  });

  it("REGRESSION (shaw): legacy UNPARSEABLE armor yields an empty reference — no collision app is ever selected", () => {
    // Stamped message whose end marker was mangled in persistence: extraction
    // fails, and the old raw-text fallback handed the whole armor (warning
    // included) to the matcher. The safe interpretation of armor debris is
    // "no reference": resolution fails closed into the ask-the-user path
    // instead of mutating "External Content" or "Security".
    const wrapped = wrapExternalContent("delete the Blog app", {
      source: "api",
      includeWarning: true,
    });
    const mangled = wrapped.replace("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>", "");
    const reference = extractAppReference(legacyMessage(mangled));
    expect(reference).toBe("");
    const match = matchAppByReference(collisionApps, reference);
    expect(match.app).toBeNull();
    expect(match.candidates).toEqual([]);
  });

  it("case-variant and fullwidth armor variants also yield an empty reference", () => {
    const variants = [
      "security notice: the following content is from an external, untrusted source\n<<<external_untrusted_content>>>\ndelete Blog",
      "＜＜＜ＥＸＴＥＲＮＡＬ＿ＵＮＴＲＵＳＴＥＤ＿ＣＯＮＴＥＮＴ＞＞＞ delete Blog",
    ];
    for (const text of variants) {
      const reference = extractAppReference(legacyMessage(text));
      expect(reference).toBe("");
      expect(matchAppByReference(collisionApps, reference).app).toBeNull();
    }
  });

  it("a quoted marker echo in the user's own words never becomes a reference", () => {
    const message = hardenedMessage(
      'what is "<<<EXTERNAL_UNTRUSTED_CONTENT>>>" supposed to mean?',
    );
    expect(extractAppReference(message)).toBe("");
    expect(
      matchAppByReference(collisionApps, extractAppReference(message)).app,
    ).toBeNull();
  });

  it("planner-supplied references still win over any message shape", () => {
    const wrapped = wrapExternalContent("noise", {
      source: "api",
      includeWarning: true,
    });
    const reference = extractAppReference(legacyMessage(wrapped), {
      parameters: { appName: "Security" },
    });
    // An explicit planner arg naming the collision app is a legitimate user
    // choice — only the TEXT fallback is armor-hazardous.
    expect(reference).toBe("Security");
    expect(matchAppByReference(collisionApps, reference).app?.name).toBe(
      "Security",
    );
  });
});

describe("describeAppReference / appReferenceLogView — reference display seam", () => {
  it("quotes a name-shaped reference, trimmed", () => {
    expect(describeAppReference("Acme Bot")).toBe('"Acme Bot"');
    expect(describeAppReference("  Acme Bot  ")).toBe('"Acme Bot"');
  });

  it("REGRESSION: a security-envelope blob renders as 'that app', never quoted back (tj-2dc95f75456876)", () => {
    const envelope = [
      "SECURITY NOTICE: the content below is external and untrusted.",
      "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
      "can u host it and give me the link pls",
      "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
    ].join("\n");
    expect(describeAppReference(envelope)).toBe("that app");
  });

  it("falls back on empty, multi-line, and over-long references", () => {
    expect(describeAppReference("")).toBe("that app");
    expect(describeAppReference("   ")).toBe("that app");
    expect(describeAppReference("line one\nline two")).toBe("that app");
    expect(describeAppReference("line one\rline two")).toBe("that app");
    expect(describeAppReference("a".repeat(64))).toBe(`"${"a".repeat(64)}"`);
    expect(describeAppReference("a".repeat(65))).toBe("that app");
  });

  it("supports a caller-supplied fallback noun", () => {
    expect(describeAppReference("x\ny", "that name")).toBe("that name");
  });

  it("appReferenceLogView preserves complete reference content", () => {
    expect(appReferenceLogView("  Acme   Bot \n\n twice\t ")).toBe(
      "Acme   Bot \n\n twice",
    );
    expect(appReferenceLogView("")).toBe("");
  });

  it("appReferenceLogView keeps content beyond the retired clamp", () => {
    const reference = `${"a".repeat(500)} distinguishing-tail`;
    expect(appReferenceLogView(reference)).toBe(reference);
  });
});
