/**
 * Unit tests for the extraction helpers — verify the pure-function
 * `managerOfAtCompany` shape that the planner constructs before calling
 * `applyExtractedEdges` against the live stores.
 */

import { describe, expect, it } from "vitest";
import { managerOfAtCompany } from "./extraction.js";
import { SELF_ENTITY_ID } from "../entities/types.js";

describe("managerOfAtCompany extractor", () => {
  it("produces three edges: self→manager:managed_by, self→company:works_at, manager→company:works_at", () => {
    const edges = managerOfAtCompany("Pat", "Acme");
    expect(edges).toHaveLength(3);
    const [first, second, third] = edges;
    expect(first?.fromRef.id).toBe(SELF_ENTITY_ID);
    expect(first?.toRef.name).toBe("Pat");
    expect(first?.type).toBe("managed_by");
    expect(second?.fromRef.id).toBe(SELF_ENTITY_ID);
    expect(second?.toRef.name).toBe("Acme");
    expect(second?.toRef.type).toBe("organization");
    expect(second?.type).toBe("works_at");
    expect(third?.fromRef.name).toBe("Pat");
    expect(third?.toRef.name).toBe("Acme");
    expect(third?.type).toBe("works_at");
  });

  it("attaches managerRole metadata to managed_by edge when provided", () => {
    const edges = managerOfAtCompany("Pat", "Acme", {
      managerRole: "VP Engineering",
    });
    const managedBy = edges.find((e) => e.type === "managed_by");
    expect(managedBy?.metadata).toEqual({ role: "VP Engineering" });
  });
});
