import { describe, expect, it } from "bun:test";
import {
  buildConnectorCta,
  confirmationPrompt,
  isExplicitConfirmation,
} from "../src/safety.ts";

const TARGET = {
  name: "Acme Bot",
  id: "11111111-2222-3333-4444-555555555555",
  aliases: ["acme-bot"],
};

describe("isExplicitConfirmation", () => {
  it("rejects a plain first ask (no affirmation word)", () => {
    expect(isExplicitConfirmation("delete my Acme Bot app", TARGET)).toBe(
      false,
    );
    expect(isExplicitConfirmation("remove acme-bot please", TARGET)).toBe(
      false,
    );
  });

  it("accepts an affirmation + verb", () => {
    expect(isExplicitConfirmation("yes delete it", TARGET)).toBe(true);
    expect(isExplicitConfirmation("delete Acme Bot — yes", TARGET)).toBe(true);
    expect(isExplicitConfirmation("confirm, delete the app", TARGET)).toBe(
      true,
    );
  });

  it("accepts an affirmation + target reference (name/slug/id)", () => {
    expect(isExplicitConfirmation("yes, Acme Bot", TARGET)).toBe(true);
    expect(isExplicitConfirmation("go ahead with acme-bot", TARGET)).toBe(true);
    expect(
      isExplicitConfirmation(
        "yes 11111111-2222-3333-4444-555555555555",
        TARGET,
      ),
    ).toBe(true);
  });

  it("rejects a bare affirmation with no verb and no target", () => {
    expect(isExplicitConfirmation("yes", TARGET)).toBe(false);
    expect(isExplicitConfirmation("ok sure", TARGET)).toBe(false);
  });

  it("rejects negative / hesitant replies", () => {
    expect(isExplicitConfirmation("no, keep it", TARGET)).toBe(false);
    expect(isExplicitConfirmation("hmm not sure, maybe later", TARGET)).toBe(
      false,
    );
    expect(isExplicitConfirmation("", TARGET)).toBe(false);
  });

  it("does not match a short alias inside unrelated prose", () => {
    // 'go' alias would be < 3 chars and must be ignored.
    expect(
      isExplicitConfirmation("yes let's go", { name: "go", aliases: ["go"] }),
    ).toBe(false);
  });
});

describe("confirmationPrompt", () => {
  it("names the target, what is destroyed, and the exact token", () => {
    const prompt = confirmationPrompt(TARGET, [
      "its running container",
      "its tenant database",
    ]);
    expect(prompt).toContain("Acme Bot");
    expect(prompt).toContain(TARGET.id);
    expect(prompt).toContain("its running container");
    expect(prompt).toContain("its tenant database");
    expect(prompt.toLowerCase()).toContain("can't be undone");
    expect(prompt).toContain("delete Acme Bot — yes");
    // The prompt itself is an explicit-confirmation template; sanity-check that
    // re-feeding the suggested token confirms.
    expect(isExplicitConfirmation("delete Acme Bot — yes", TARGET)).toBe(true);
  });
});

describe("buildConnectorCta", () => {
  it("builds a neutral {label,url,kind} for an https URL", () => {
    const cta = buildConnectorCta(
      "Withdraw",
      "https://x.test/withdraw",
      "button",
    );
    expect(cta).toEqual({
      label: "Withdraw",
      url: "https://x.test/withdraw",
      kind: "button",
    });
  });

  it("rejects non-http(s) URLs (no creds/money smuggling)", () => {
    expect(() => buildConnectorCta("x", "javascript:alert(1)")).toThrow();
    expect(() => buildConnectorCta("x", "not a url")).toThrow();
  });
});
