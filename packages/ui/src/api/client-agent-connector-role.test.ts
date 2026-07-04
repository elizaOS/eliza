/**
 * Unit coverage for connector server-role→UI-role mapping and account-record
 * normalization. Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_SERVER_ROLE_TO_UI_ROLE,
  normalizeConnectorAccountRecord,
} from "./client-agent";

/**
 * Connector-account role normalization (#12087 Item 32). An unrecognized or
 * missing server role must NOT be silently relabelled `OWNER` (the fail-open
 * mislabel this replaced) — it stays `undefined` and renders outside the Owner
 * section. The server-role→UI-role mapping is an exported typed constant.
 */
describe("normalizeConnectorAccountRecord — role default", () => {
  const rec = (raw: unknown) =>
    normalizeConnectorAccountRecord("slack", "slack", raw);

  it("maps a recognized server role to its UI role (case-insensitive)", () => {
    expect(rec({ role: "OWNER" }).role).toBe("OWNER");
    expect(rec({ role: "viewer" }).role).toBe("TEAM");
    expect(rec({ role: "SERVICE" }).role).toBe("AGENT");
    expect(rec({ role: "team" }).role).toBe("TEAM");
  });

  it("leaves an unrecognized server role undefined (NOT OWNER)", () => {
    expect(rec({ role: "wizard" }).role).toBeUndefined();
    expect(rec({ role: "" }).role).toBeUndefined();
  });

  it("leaves a missing role undefined", () => {
    expect(rec({}).role).toBeUndefined();
    expect(rec({ label: "no role here" }).role).toBeUndefined();
  });

  it("falls back to the purpose field only when it names a role", () => {
    expect(rec({ purpose: "AGENT" }).role).toBe("AGENT");
    expect(rec({ purpose: "messaging" }).role).toBeUndefined();
  });
});

describe("CONNECTOR_SERVER_ROLE_TO_UI_ROLE mapping", () => {
  it("is the single typed source for server→UI role translation", () => {
    expect(CONNECTOR_SERVER_ROLE_TO_UI_ROLE.OWNER).toBe("OWNER");
    expect(CONNECTOR_SERVER_ROLE_TO_UI_ROLE.AGENT).toBe("AGENT");
    expect(CONNECTOR_SERVER_ROLE_TO_UI_ROLE.SERVICE).toBe("AGENT");
    expect(CONNECTOR_SERVER_ROLE_TO_UI_ROLE.TEAM).toBe("TEAM");
    expect(CONNECTOR_SERVER_ROLE_TO_UI_ROLE.VIEWER).toBe("TEAM");
    expect(CONNECTOR_SERVER_ROLE_TO_UI_ROLE.ADMIN).toBe("TEAM");
    expect(CONNECTOR_SERVER_ROLE_TO_UI_ROLE.MEMBER).toBe("TEAM");
    expect(CONNECTOR_SERVER_ROLE_TO_UI_ROLE.NOT_A_ROLE).toBeUndefined();
  });
});
