/**
 * Unit coverage for the starter-pack setup demo spec. Real-harness checks, no
 * mocks: the fixed fixture is rendered as-is by the renderer and stories, so
 * it must stay accepted by the package's own GenUI validator and catalog, and
 * every tree reference and action name it ships must resolve.
 */
import { describe, expect, it } from "vitest";
import {
  isElizaGenUiActionNameAllowed,
  isElizaGenUiKnownComponent,
} from "./catalog";
import { ELIZA_STARTER_PACK_SETUP_SPEC } from "./starter-pack-demo";
import { assertValidElizaGenUiSpec, validateElizaGenUiSpec } from "./validator";

describe("ELIZA_STARTER_PACK_SETUP_SPEC", () => {
  const spec = ELIZA_STARTER_PACK_SETUP_SPEC;
  const componentIds = new Set(
    spec.components.map((component) => component.id),
  );

  function validatedSpec() {
    const result = validateElizaGenUiSpec(spec);
    if (!result.ok) {
      const summary = result.errors
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ");
      throw new Error(`starter pack spec rejected by validator: ${summary}`);
    }
    return result.spec;
  }

  it("passes validateElizaGenUiSpec under default catalog options", () => {
    const validated = validatedSpec();
    expect(validated.components).toHaveLength(spec.components.length);
  });

  it("survives assertValidElizaGenUiSpec without throwing", () => {
    const validated = assertValidElizaGenUiSpec(spec);
    expect(validated.root).toBe(spec.root);
  });

  it("declares unique component ids", () => {
    expect(componentIds.size).toBe(spec.components.length);
  });

  it("roots the tree at a declared component id", () => {
    expect(componentIds.has(spec.root)).toBe(true);
  });

  it("resolves every child reference to a declared component id", () => {
    const refs = spec.components.flatMap((component) => {
      const collected: string[] = [];
      if (typeof component.child === "string") {
        collected.push(component.child);
      }
      if (Array.isArray(component.children)) {
        for (const entry of component.children) {
          if (typeof entry === "string") {
            collected.push(entry);
          }
        }
      }
      return collected;
    });
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(componentIds.has(ref)).toBe(true);
    }
  });

  it("uses only component names from the frozen catalog", () => {
    for (const component of spec.components) {
      expect(isElizaGenUiKnownComponent(component.component)).toBe(true);
    }
  });

  it("gives every interactive component an allowed action event name", () => {
    const eventNames = spec.components.flatMap((component) =>
      component.action ? [component.action.event.name] : [],
    );
    expect(eventNames.length).toBeGreaterThan(0);
    for (const name of eventNames) {
      expect(isElizaGenUiActionNameAllowed(name)).toBe(true);
    }
  });

  it("serializes well inside the default 64 KiB validation budget", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(spec)).length;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(65_536);
  });
});
