/**
 * Verifies the local dashboard bridge supplies an explicit document actor while
 * preserving caller-provided and untrusted HTTP access contexts unchanged.
 */

import type { AccessContext, AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveTrustedLocalDocumentAccessContext } from "./plugin.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002" as UUID;

function runtime(
  getSetting: (key: string) => string | undefined = () => undefined,
) {
  return {
    agentId: AGENT_ID,
    getSetting: vi.fn(getSetting),
  } as unknown as AgentRuntime;
}

describe("resolveTrustedLocalDocumentAccessContext", () => {
  it("preserves an already-resolved access context", () => {
    const accessContext = {
      requesterEntityId: OWNER_ID,
      role: "OWNER",
      isOwner: true,
    } satisfies AccessContext;

    expect(
      resolveTrustedLocalDocumentAccessContext({
        accessContext,
        isTrustedLocal: true,
        runtime: runtime(),
      }),
    ).toBe(accessContext);
  });

  it("does not mint a principal for an untrusted request", () => {
    expect(
      resolveTrustedLocalDocumentAccessContext({
        accessContext: undefined,
        isTrustedLocal: false,
        runtime: runtime(() => OWNER_ID),
      }),
    ).toBeUndefined();
  });

  it("uses the configured owner for trusted local requests", () => {
    expect(
      resolveTrustedLocalDocumentAccessContext({
        accessContext: undefined,
        isTrustedLocal: true,
        runtime: runtime(() => OWNER_ID),
      }),
    ).toMatchObject({
      requesterEntityId: OWNER_ID,
      role: "OWNER",
      isOwner: true,
      source: "trusted-local",
    });
  });

  it("uses the runtime agent as the trusted local self actor", () => {
    expect(
      resolveTrustedLocalDocumentAccessContext({
        accessContext: undefined,
        isTrustedLocal: true,
        runtime: runtime(),
      }),
    ).toEqual({
      requesterEntityId: AGENT_ID,
      source: "trusted-local",
    });
  });
});
