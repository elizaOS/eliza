/**
 * Tests for the two-phase confirm state machine (readStructuredConfirmation and the conflicting-target/amount/domain guards). Pure — planner-boolean parsing, never prose. No SDK.
 */
import { describe, expect, it } from "bun:test";
import {
  buildConnectorCta,
  CONFIRM_TTL_MS,
  confirmationPrompt,
  confirmReferenceMatchesTarget,
  conflictingConfirmAmount,
  conflictingConfirmDomain,
  conflictingConfirmTarget,
  pendingExpired,
  readStructuredConfirmation,
} from "../src/safety.ts";

const TARGET = {
  name: "Acme Bot",
  id: "11111111-2222-3333-4444-555555555555",
  aliases: ["acme-bot"],
};

describe("readStructuredConfirmation", () => {
  it("accepts only structured boolean-ish confirmation fields", () => {
    expect(readStructuredConfirmation({ confirm: true })).toBe(true);
    expect(readStructuredConfirmation({ confirm: false })).toBe(false);
    expect(readStructuredConfirmation({ confirmed: "1" })).toBe(true);
    expect(readStructuredConfirmation({ confirm: "0" })).toBe(false);
  });

  it("reads the confirmation from the real planner path (options.parameters)", () => {
    // The runtime nests validated action parameters under options.parameters
    // (execute-planned-tool-call.ts). Reading only the top level made confirm
    // invisible on every real turn, so the destructive action could never fire.
    expect(readStructuredConfirmation({ parameters: { confirm: true } })).toBe(
      true,
    );
    expect(readStructuredConfirmation({ parameters: { confirm: false } })).toBe(
      false,
    );
    expect(readStructuredConfirmation({ parameters: { confirmed: "1" } })).toBe(
      true,
    );
    expect(readStructuredConfirmation({ parameters: {} })).toBe(null);
    // The nested (planner-extracted) value is authoritative over any top-level.
    expect(
      readStructuredConfirmation({
        parameters: { confirm: false },
        confirm: true,
      }),
    ).toBe(false);
    // Prose is still never treated as confirmation, even when nested.
    expect(readStructuredConfirmation({ parameters: { confirm: "yes" } })).toBe(
      null,
    );
  });

  it("does not infer confirmation from user prose", () => {
    expect(readStructuredConfirmation(undefined)).toBe(null);
    expect(readStructuredConfirmation({ text: "yes delete Acme Bot" })).toBe(
      null,
    );
    expect(readStructuredConfirmation({ confirm: "yes" })).toBe(null);
    expect(
      readStructuredConfirmation({ confirm: "delete Acme Bot — yes" }),
    ).toBe(null);
  });
});

describe("confirmReferenceMatchesTarget (frozen-target guard)", () => {
  it("matches the frozen target by id, exact name, alias, and partial name", () => {
    expect(confirmReferenceMatchesTarget(TARGET.id, TARGET)).toBe(true);
    expect(confirmReferenceMatchesTarget("Acme Bot", TARGET)).toBe(true);
    expect(confirmReferenceMatchesTarget("acme bot", TARGET)).toBe(true);
    expect(confirmReferenceMatchesTarget("acme-bot", TARGET)).toBe(true);
    // Partial names of the SAME target must never read as a switch.
    expect(confirmReferenceMatchesTarget("Acme", TARGET)).toBe(true);
    // A longer phrase containing the frozen name still matches.
    expect(confirmReferenceMatchesTarget("the Acme Bot app", TARGET)).toBe(
      true,
    );
  });

  it("treats generic filler as a non-reference (never blocks)", () => {
    expect(confirmReferenceMatchesTarget("my app", TARGET)).toBe(true);
    expect(confirmReferenceMatchesTarget("the app", TARGET)).toBe(true);
    expect(confirmReferenceMatchesTarget("it", TARGET)).toBe(true);
  });

  it("rejects a clearly different target", () => {
    expect(confirmReferenceMatchesTarget("Beta Dashboard", TARGET)).toBe(false);
    expect(
      confirmReferenceMatchesTarget(
        "99999999-8888-7777-6666-555555555555",
        TARGET,
      ),
    ).toBe(false);
  });
});

describe("conflictingConfirmTarget", () => {
  it("returns null on a bare confirm (no reference sent)", () => {
    expect(conflictingConfirmTarget({ confirm: true }, TARGET)).toBe(null);
    expect(
      conflictingConfirmTarget({ parameters: { confirm: true } }, TARGET),
    ).toBe(null);
    expect(conflictingConfirmTarget(undefined, TARGET)).toBe(null);
  });

  it("returns null when the confirm turn re-names the SAME target", () => {
    expect(
      conflictingConfirmTarget(
        { parameters: { confirm: true, appName: "acme" } },
        TARGET,
      ),
    ).toBe(null);
  });

  it("returns the conflicting reference when a DIFFERENT target is named (nested planner path)", () => {
    expect(
      conflictingConfirmTarget(
        { parameters: { confirm: true, appName: "Beta Dashboard" } },
        TARGET,
      ),
    ).toBe("Beta Dashboard");
    expect(
      conflictingConfirmTarget({ confirm: true, appName: "Beta" }, TARGET),
    ).toBe("Beta");
  });

  it("honors custom reference keys (influencer bookings)", () => {
    expect(
      conflictingConfirmTarget(
        { parameters: { confirm: true, influencer: "Bob Creator" } },
        { name: "Alice Creator", id: "profile-1" },
        ["profileId", "influencer"],
      ),
    ).toBe("Bob Creator");
    expect(
      conflictingConfirmTarget(
        { parameters: { confirm: true, profileId: "profile-1" } },
        { name: "Alice Creator", id: "profile-1" },
        ["profileId", "influencer"],
      ),
    ).toBe(null);
  });
});

describe("conflictingConfirmAmount", () => {
  it("returns null on a bare confirm or a matching amount", () => {
    expect(conflictingConfirmAmount({ confirm: true }, 100)).toBe(null);
    expect(conflictingConfirmAmount({ parameters: { amount: 100 } }, 100)).toBe(
      null,
    );
    expect(
      conflictingConfirmAmount({ parameters: { amount: "100" } }, 100),
    ).toBe(null);
    expect(
      conflictingConfirmAmount({ parameters: { amount: "$100" } }, 100),
    ).toBe(null);
  });

  it("returns the conflicting amount when the confirm turn names a different one", () => {
    expect(conflictingConfirmAmount({ parameters: { amount: 50 } }, 100)).toBe(
      50,
    );
    expect(conflictingConfirmAmount({ amount: "50" }, 100)).toBe(50);
  });

  it("ignores prose amounts (never guesses)", () => {
    expect(
      conflictingConfirmAmount({ parameters: { amount: "fifty bucks" } }, 100),
    ).toBe(null);
  });
});

describe("conflictingConfirmDomain", () => {
  it("returns null on a bare confirm or the same domain", () => {
    expect(conflictingConfirmDomain({ confirm: true }, "yourbrand.com")).toBe(
      null,
    );
    expect(
      conflictingConfirmDomain(
        { parameters: { domain: "yourbrand.com" } },
        "yourbrand.com",
      ),
    ).toBe(null);
    expect(
      conflictingConfirmDomain(
        { parameters: { domain: "WWW.YourBrand.com" } },
        "yourbrand.com",
      ),
    ).toBe(null);
  });

  it("domains compare exactly: a substring domain is a DIFFERENT domain", () => {
    expect(
      conflictingConfirmDomain(
        { parameters: { domain: "brand.com" } },
        "yourbrand.com",
      ),
    ).toBe("brand.com");
    expect(
      conflictingConfirmDomain(
        { parameters: { domain: "other.io" } },
        "yourbrand.com",
      ),
    ).toBe("other.io");
  });

  it("ignores values that don't look like a domain", () => {
    expect(
      conflictingConfirmDomain(
        { parameters: { domain: "the domain" } },
        "yourbrand.com",
      ),
    ).toBe(null);
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
    expect(prompt).toContain("confirm delete Acme Bot");
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

describe("pendingExpired (shared confirm TTL)", () => {
  const base = {
    taskId: "task-1",
    metadata: {
      roomId: "room-1",
      action: "BOOK_INFLUENCER" as const,
      appId: "inf_1",
      appName: "Nova",
      amount: 200,
    },
  };

  it("a fresh pending is not expired", () => {
    const pending = {
      ...base,
      metadata: {
        ...base.metadata,
        intentCreatedAt: new Date().toISOString(),
      },
    };
    expect(pendingExpired(pending)).toBe(false);
  });

  it("a pending older than CONFIRM_TTL_MS is expired", () => {
    const pending = {
      ...base,
      metadata: {
        ...base.metadata,
        intentCreatedAt: new Date(
          Date.now() - CONFIRM_TTL_MS - 1000,
        ).toISOString(),
      },
    };
    expect(pendingExpired(pending)).toBe(true);
  });

  it("a pending with no/invalid intentCreatedAt never expires (no timestamp to age)", () => {
    expect(pendingExpired(base)).toBe(false);
    expect(
      pendingExpired({
        ...base,
        metadata: { ...base.metadata, intentCreatedAt: "not-a-date" },
      }),
    ).toBe(false);
  });

  it("a BUY_APP_DOMAIN recovery retry never expires (no new charge at stake)", () => {
    const pending = {
      ...base,
      metadata: {
        ...base.metadata,
        action: "BUY_APP_DOMAIN" as const,
        recovery: true,
        intentCreatedAt: new Date(
          Date.now() - CONFIRM_TTL_MS * 10,
        ).toISOString(),
      },
    };
    expect(pendingExpired(pending)).toBe(false);
  });
});
