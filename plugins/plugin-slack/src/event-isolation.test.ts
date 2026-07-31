/**
 * Workspace isolation unit proof.
 *
 * The rule under test is asymmetric on purpose: fail-CLOSED on a field that is
 * present and different, fail-OPEN on a field that is absent. Both directions
 * are asserted, because a guard that drops everything is not isolation, it is
 * an outage.
 */
import { describe, expect, it } from "vitest";
import {
  extractSlackEnvelopeIdentity,
  shouldDropMismatchedSlackEvent,
} from "./event-isolation";

const IDENTITY = { apiAppId: "A_APP", teamId: "T_HOME", enterpriseId: null };

function verdict(body: unknown, identity = IDENTITY) {
  return shouldDropMismatchedSlackEvent({ body, identity });
}

describe("extractSlackEnvelopeIdentity", () => {
  it("reads the standard Events API envelope", () => {
    expect(
      extractSlackEnvelopeIdentity({ api_app_id: "A1", team_id: "T1" }),
    ).toEqual({ apiAppId: "A1", teamId: "T1", enterpriseId: "" });
  });

  it("falls back to team.id, event.team, and authorizations", () => {
    expect(extractSlackEnvelopeIdentity({ team: { id: "T2" } }).teamId).toBe(
      "T2",
    );
    expect(extractSlackEnvelopeIdentity({ event: { team: "T3" } }).teamId).toBe(
      "T3",
    );
    expect(
      extractSlackEnvelopeIdentity({ authorizations: [{ team_id: "T4" }] })
        .teamId,
    ).toBe("T4");
  });

  it("returns empties for junk input", () => {
    expect(extractSlackEnvelopeIdentity(null)).toEqual({
      apiAppId: "",
      teamId: "",
      enterpriseId: "",
    });
    expect(extractSlackEnvelopeIdentity("nope").teamId).toBe("");
  });
});

describe("shouldDropMismatchedSlackEvent — fail closed on mismatch", () => {
  it("drops a foreign team_id", () => {
    expect(verdict({ api_app_id: "A_APP", team_id: "T_OTHER" })).toMatchObject({
      drop: true,
      field: "team_id",
      expected: "T_HOME",
      received: "T_OTHER",
    });
  });

  it("drops a foreign api_app_id", () => {
    expect(verdict({ api_app_id: "A_OTHER", team_id: "T_HOME" })).toMatchObject(
      {
        drop: true,
        field: "api_app_id",
      },
    );
  });

  it("reports api_app_id first when both mismatch", () => {
    expect(
      verdict({ api_app_id: "A_OTHER", team_id: "T_OTHER" }),
    ).toMatchObject({ drop: true, field: "api_app_id" });
  });

  it("drops a foreign team carried only on the nested event", () => {
    expect(verdict({ event: { team: "T_OTHER" } })).toMatchObject({
      drop: true,
      field: "team_id",
    });
  });

  it("drops a foreign enterprise_id", () => {
    expect(
      shouldDropMismatchedSlackEvent({
        body: { enterprise_id: "E_OTHER" },
        identity: { ...IDENTITY, enterpriseId: "E_HOME" },
      }),
    ).toMatchObject({ drop: true, field: "enterprise_id" });
  });
});

describe("shouldDropMismatchedSlackEvent — fail open on absence", () => {
  it("accepts a matching envelope", () => {
    expect(verdict({ api_app_id: "A_APP", team_id: "T_HOME" }).drop).toBe(
      false,
    );
  });

  it("accepts an envelope carrying no identity fields", () => {
    expect(verdict({ type: "event_callback" }).drop).toBe(false);
  });

  it("accepts when the account identity is not yet known", () => {
    expect(
      shouldDropMismatchedSlackEvent({
        body: { api_app_id: "A_ANY", team_id: "T_ANY" },
        identity: {},
      }).drop,
    ).toBe(false);
  });

  it("accepts non-object bodies rather than throwing", () => {
    expect(verdict(null).drop).toBe(false);
    expect(verdict(undefined).drop).toBe(false);
    expect(verdict("string").drop).toBe(false);
  });

  it("accepts a sibling workspace inside the expected org-wide install", () => {
    // Org-wide installs legitimately receive events from sibling teams, so a
    // team mismatch INSIDE the expected enterprise is not cross-tenant bleed.
    expect(
      shouldDropMismatchedSlackEvent({
        body: { team_id: "T_SIBLING", enterprise_id: "E_HOME" },
        identity: {
          apiAppId: "A_APP",
          teamId: "T_HOME",
          enterpriseId: "E_HOME",
        },
      }).drop,
    ).toBe(false);
  });

  it("still drops a sibling-looking team from a different enterprise", () => {
    expect(
      shouldDropMismatchedSlackEvent({
        body: { team_id: "T_SIBLING", enterprise_id: "E_OTHER" },
        identity: {
          apiAppId: "A_APP",
          teamId: "T_HOME",
          enterpriseId: "E_HOME",
        },
      }).drop,
    ).toBe(true);
  });
});
