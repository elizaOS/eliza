import { describe, expect, it } from "bun:test";
import { findAppByReference, matchAppByReference } from "../src/client.ts";
import { makeApp } from "./helpers";

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
    // The old raw-substring find() returned the first (prefix) match, so a
    // single "delete Prod API Backup — yes" tore down the wrong "Prod API".
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
