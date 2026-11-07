import { describe, expect, it } from "bun:test";
import {
  filterActionsByRouting,
  getActiveRoutingContexts,
  parseContextRoutingMetadata,
} from "./context-routing";

describe("parseContextRoutingMetadata", () => {
  it("keeps a listed context when the primary context is not the first listed context", () => {
    const routing = parseContextRoutingMetadata({
      primaryContext: "documents",
      contexts: ["wallet", "documents"],
    });
    expect(routing.primaryContext).toBe("documents");
    expect(routing.secondaryContexts).toEqual(["wallet"]);
    expect(getActiveRoutingContexts(routing)).toEqual(["general", "documents", "wallet"]);
    const actions = [{ name: "SEND_TOKEN" }, { name: "SEARCH_DOCUMENT" }] as never[];
    expect(
      filterActionsByRouting(actions, routing).map((action: { name: string }) => action.name),
    ).toEqual(["SEND_TOKEN", "SEARCH_DOCUMENT"]);
  });

  it("keeps the existing behavior when the primary context is the first listed context", () => {
    const routing = parseContextRoutingMetadata({
      primaryContext: "wallet",
      contexts: ["wallet", "documents"],
    });
    expect(routing.primaryContext).toBe("wallet");
    expect(routing.secondaryContexts).toEqual(["documents"]);
  });

  it("keeps the existing behavior when no primary context is given", () => {
    const routing = parseContextRoutingMetadata({
      contexts: ["wallet", "documents"],
    });
    expect(routing.primaryContext).toBe("wallet");
    expect(routing.secondaryContexts).toEqual(["documents"]);
  });

  it("keeps the existing behavior for a stored primary and secondary decision", () => {
    const routing = parseContextRoutingMetadata({
      primaryContext: "wallet",
      secondaryContexts: ["documents"],
    });
    expect(routing.primaryContext).toBe("wallet");
    expect(routing.secondaryContexts).toEqual(["documents"]);
  });

  it("merges explicit secondary contexts with the listed contexts", () => {
    const routing = parseContextRoutingMetadata({
      primaryContext: "documents",
      secondaryContexts: ["browser"],
      contexts: ["wallet", "documents"],
    });
    expect(routing.primaryContext).toBe("documents");
    expect(routing.secondaryContexts).toEqual(["browser", "wallet"]);
  });
});
