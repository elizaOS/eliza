/**
 * Deterministic unit coverage for the shared capability presentation
 * vocabulary (#19884): sanitizing grant extraction from untrusted wire
 * metadata, chip building including the unreported-vs-empty distinction,
 * exhaustive status→tone mapping, and incremental-scope request unions.
 */

import { describe, expect, it } from "vitest";
import type { ConnectorAccountStatus } from "../../api/client-agent-connector-accounts";
import {
  incrementalScopeRequest,
  presentConnectorAccountStatus,
  presentConnectorCapabilityChips,
  readConnectorAccountCapabilityAccess,
} from "./connected-capability-presentation";

const DECLARED = [
  {
    id: "gmail.read",
    group: "Gmail",
    label: "Read Gmail",
    description: "Search and read Gmail messages.",
  },
  {
    id: "gmail.send",
    group: "Gmail",
    label: "Send Gmail",
    description: "Send email through Gmail.",
  },
] as const;

describe("readConnectorAccountCapabilityAccess", () => {
  it("reads granted ids from the first known metadata key", () => {
    const access = readConnectorAccountCapabilityAccess({
      metadata: {
        grantedCapabilities: ["gmail.read", " gmail.send "],
        requestedCapabilities: ["ignored.when.granted.present"],
      },
    });
    expect(access).toEqual({
      reported: true,
      granted: new Set(["gmail.read", "gmail.send"]),
    });
  });

  it("never reads client-written intent as a grant: requested-but-denied stays unreported", () => {
    // `requestedCapabilities` is written by this client before the OAuth
    // round trip; a denied or cancelled consent leaves only that key behind.
    expect(
      readConnectorAccountCapabilityAccess({
        metadata: { requestedCapabilities: ["gmail.read", "gmail.send"] },
      }),
    ).toEqual({ reported: false });
  });

  it("reports a partial grant exactly, not the requested superset", () => {
    expect(
      readConnectorAccountCapabilityAccess({
        metadata: {
          grantedCapabilities: ["gmail.read"],
          requestedCapabilities: ["gmail.read", "gmail.send"],
        },
      }),
    ).toEqual({ reported: true, granted: new Set(["gmail.read"]) });
  });

  it("keeps an explicitly empty grant set distinct from unreported", () => {
    expect(
      readConnectorAccountCapabilityAccess({
        metadata: { grantedCapabilities: [] },
      }),
    ).toEqual({ reported: true, granted: new Set() });
    expect(readConnectorAccountCapabilityAccess({ metadata: {} })).toEqual({
      reported: false,
    });
    expect(readConnectorAccountCapabilityAccess({})).toEqual({
      reported: false,
    });
  });

  it("drops malformed members and non-array values", () => {
    expect(
      readConnectorAccountCapabilityAccess({
        metadata: {
          grantedCapabilities: [42, "", "  ", "ok", "x".repeat(121), null],
        },
      }),
    ).toEqual({ reported: true, granted: new Set(["ok"]) });
    // A non-array value under the first key falls through to the next key.
    expect(
      readConnectorAccountCapabilityAccess({
        metadata: {
          grantedCapabilities: "gmail.read",
          scopes: ["gmail.read"],
        },
      }),
    ).toEqual({ reported: true, granted: new Set(["gmail.read"]) });
  });
});

describe("presentConnectorCapabilityChips", () => {
  it("returns null for unreported access so the caller renders the distinct state", () => {
    expect(presentConnectorCapabilityChips({ reported: false }, DECLARED)).toBe(
      null,
    );
  });

  it("marks granted and missing declared capabilities", () => {
    const chips = presentConnectorCapabilityChips(
      { reported: true, granted: new Set(["gmail.read"]) },
      DECLARED,
    );
    expect(chips).toEqual([
      {
        id: "gmail.read",
        label: "Read Gmail",
        description: "Gmail: Search and read Gmail messages.",
        state: "granted",
        action: null,
      },
      {
        id: "gmail.send",
        label: "Send Gmail",
        description: "Gmail: Send email through Gmail.",
        state: "missing",
        action: "grant",
      },
    ]);
  });

  it("keeps granted-but-undeclared ids visible as plain granted chips", () => {
    const chips = presentConnectorCapabilityChips(
      { reported: true, granted: new Set(["gmail.read", "legacy.scope"]) },
      DECLARED,
    );
    expect(chips?.find((chip) => chip.id === "legacy.scope")).toEqual({
      id: "legacy.scope",
      label: "legacy.scope",
      description: "legacy.scope",
      state: "granted",
      action: null,
    });
  });

  it("returns an empty list for a reported-empty grant with nothing declared", () => {
    expect(
      presentConnectorCapabilityChips(
        { reported: true, granted: new Set() },
        [],
      ),
    ).toEqual([]);
  });
});

describe("presentConnectorAccountStatus", () => {
  const cases: Array<[ConnectorAccountStatus | undefined, string, boolean]> = [
    ["connected", "success", false],
    ["pending", "warning", false],
    ["needs-reauth", "danger", true],
    ["error", "danger", true],
    ["disconnected", "muted", true],
    ["unknown", "muted", false],
    [undefined, "muted", false],
  ];
  it.each(cases)("maps %s", (status, tone, needsReconnect) => {
    expect(presentConnectorAccountStatus(status)).toEqual({
      tone,
      needsReconnect,
    });
  });
});

describe("incrementalScopeRequest", () => {
  it("unions granted scopes with the requested capability", () => {
    expect(
      incrementalScopeRequest(
        { reported: true, granted: new Set(["gmail.read"]) },
        "gmail.send",
      ),
    ).toEqual(["gmail.read", "gmail.send"]);
  });

  it("never narrows: requesting an already granted capability is idempotent", () => {
    expect(
      incrementalScopeRequest(
        { reported: true, granted: new Set(["gmail.read", "gmail.send"]) },
        "gmail.read",
      ),
    ).toEqual(["gmail.read", "gmail.send"]);
  });

  it("fails closed to only the clicked capability when access is unreported", () => {
    expect(incrementalScopeRequest({ reported: false }, "gmail.send")).toEqual([
      "gmail.send",
    ]);
  });
});
