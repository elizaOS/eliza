/**
 * Tests for the ambiguity-safe app resolver (matchAppByReference / findAppByReference / resolveApp): id then exact name/slug then whole-word then fragment; ties are ambiguous. Pure, no SDK.
 */
import { describe, expect, it } from "bun:test";
import {
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
