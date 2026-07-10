/**
 * Context-selection tests for music action exposure.
 *
 * The helper is intentionally pure because action validators call it before
 * service lookup or model extraction, so these tests pin the state contracts
 * that can expose music actions.
 */
import { CONTEXT_ROUTING_STATE_KEY, type State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { selectedContextMatches } from "./selectedContextMatches";

function state(values?: State["values"], data?: State["data"]): State {
  return { values, data } as State;
}

describe("selectedContextMatches", () => {
  it("matches selected contexts from values", () => {
    expect(
      selectedContextMatches(
        state({ selectedContexts: ["media", "knowledge"] }),
        ["media"],
      ),
    ).toBe(true);
  });

  it("matches selected contexts from data", () => {
    expect(
      selectedContextMatches(
        state(undefined, { selectedContexts: ["media"] }),
        ["media"],
      ),
    ).toBe(true);
  });

  it("matches selected contexts from context object trajectory and metadata", () => {
    const contextObject = {
      trajectoryPrefix: { selectedContexts: ["knowledge"] },
      metadata: { selectedContexts: ["media"] },
    };

    expect(
      selectedContextMatches(state(undefined, { contextObject }), [
        "knowledge",
      ]),
    ).toBe(true);
    expect(
      selectedContextMatches(state(undefined, { contextObject }), ["media"]),
    ).toBe(true);
  });

  it("ignores planner routing unless explicitly enabled", () => {
    const routedState = state({
      [CONTEXT_ROUTING_STATE_KEY]: {
        primaryContext: "media",
        secondaryContexts: ["knowledge"],
      },
    });

    expect(selectedContextMatches(routedState, ["media"])).toBe(false);
    expect(
      selectedContextMatches(routedState, ["media"], {
        includeContextRouting: true,
      }),
    ).toBe(true);
    expect(
      selectedContextMatches(routedState, ["knowledge"], {
        includeContextRouting: true,
      }),
    ).toBe(true);
  });

  it("ignores malformed and missing state without fabricating a match", () => {
    expect(selectedContextMatches(undefined, ["media"])).toBe(false);
    expect(
      selectedContextMatches(
        state(
          { selectedContexts: ["media", 123] },
          { selectedContexts: "media" },
        ),
        ["media"],
      ),
    ).toBe(true);
    expect(
      selectedContextMatches(
        state(
          {
            selectedContexts: [123],
            [CONTEXT_ROUTING_STATE_KEY]: {
              primaryContext: 456,
              secondaryContexts: ["files"],
            },
          },
          { selectedContexts: "media" },
        ),
        ["media"],
        { includeContextRouting: true },
      ),
    ).toBe(false);
  });
});
