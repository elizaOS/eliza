// Exercises context routing behavior with deterministic cloud-shared lib fixtures.
import type { Action } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import {
  deriveAvailableContexts,
  filterActionsByRouting,
  getActiveRoutingContexts,
  parseContextList,
  parseContextRoutingMetadata,
  resolveActionContexts,
} from "./context-routing";

/**
 * Context routing narrows which actions a response may invoke. Parsing must
 * normalize + dedupe + drop unknown contexts; "general" is always active (so a
 * general-only routing never hides actions); and filtering keeps an action
 * only when one of its contexts is active — the gate that stops, e.g., a wallet
 * transfer from firing in a documents-only turn.
 */

const action = (name: string, contexts?: string[]): Action =>
  ({ name, ...(contexts ? { contexts } : {}) }) as unknown as Action;

describe("parseContextList", () => {
  test("splits, normalizes, dedupes, and drops unknown contexts", () => {
    expect(parseContextList("wallet, WALLET; documents\nbogus")).toEqual(["wallet", "documents"]);
    expect(parseContextList(["wallet", "code"])).toEqual(["wallet", "code"]);
    expect(parseContextList(undefined)).toEqual([]);
  });
});

describe("parseContextRoutingMetadata", () => {
  test("derives primary + de-duplicated secondary contexts", () => {
    const routing = parseContextRoutingMetadata({
      contexts: ["wallet", "documents", "wallet"],
    });
    expect(routing.primaryContext).toBe("wallet");
    expect(routing.secondaryContexts).toEqual(["documents"]);
  });

  test("non-object input yields an empty decision", () => {
    expect(parseContextRoutingMetadata("nope")).toEqual({});
  });
});

describe("getActiveRoutingContexts", () => {
  test("always includes general plus primary + secondary", () => {
    expect(
      getActiveRoutingContexts({ primaryContext: "wallet", secondaryContexts: ["code"] }).sort(),
    ).toEqual(["code", "general", "wallet"]);
    expect(getActiveRoutingContexts({})).toEqual(["general"]);
  });
});

describe("resolveActionContexts", () => {
  test("declared contexts win, else map lookup, else general", () => {
    expect(resolveActionContexts(action("ANYTHING", ["media"]))).toEqual(["media"]);
    expect(resolveActionContexts(action("SEND_TOKEN"))).toEqual(["wallet"]);
    expect(resolveActionContexts(action("TOTALLY_UNKNOWN"))).toEqual(["general"]);
  });
});

describe("deriveAvailableContexts", () => {
  test("collects, includes general, and sorts", () => {
    const got = deriveAvailableContexts([action("SEND_TOKEN"), action("BROWSE")], []);
    expect(got).toEqual(["browser", "general", "wallet"]);
  });
});

describe("filterActionsByRouting", () => {
  const actions = [action("SEND_TOKEN"), action("BROWSE"), action("REPLY")];

  test("general-only routing keeps all actions", () => {
    expect(filterActionsByRouting(actions, {})).toHaveLength(3);
  });

  test("wallet routing keeps wallet + general actions, drops browser", () => {
    const kept = filterActionsByRouting(actions, { primaryContext: "wallet" }).map((a) => a.name);
    expect(kept).toContain("SEND_TOKEN");
    expect(kept).toContain("REPLY"); // general always active
    expect(kept).not.toContain("BROWSE");
  });
});
