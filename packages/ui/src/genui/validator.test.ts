/**
 * Unit coverage for the GenUI spec validator's structural contract: header
 * checks, component-array caps, catalog/id/action rules, reference integrity,
 * image-source safety, size options, and the snapshot guarantees (severed
 * prototypes, -0 normalization) the renderer relies on. Drives the real
 * module; hostile-walk ceilings live in validator.unbounded.test.ts and the
 * randomized never-throws contract in validator.fuzz.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ELIZA_GENUI_ALLOWED_COMPONENTS } from "./catalog";
import type { ElizaGenUiValidationOptions } from "./types";
import { assertValidElizaGenUiSpec, validateElizaGenUiSpec } from "./validator";

function validSpec(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.1",
    root: "root-node",
    components: [{ id: "root-node", component: "Text" }],
    ...overrides,
  };
}

function expectOk(value: unknown, options?: ElizaGenUiValidationOptions) {
  const result = validateElizaGenUiSpec(value, options);
  if (!result.ok) {
    throw new Error(
      `expected an ok spec but got: ${result.errors
        .map((issue) => issue.message)
        .join("\n")}`,
    );
  }
  return result.spec;
}

function expectErrors(value: unknown, options?: ElizaGenUiValidationOptions) {
  const result = validateElizaGenUiSpec(value, options);
  if (result.ok) throw new Error("expected the spec to be rejected");
  return result.errors;
}

describe("validateElizaGenUiSpec accepted specs", () => {
  it("accepts a minimal connected spec and echoes its structure", () => {
    const spec = expectOk(validSpec());
    expect(spec.version).toBe("0.1");
    expect(spec.root).toBe("root-node");
    expect(spec.components).toHaveLength(1);
    expect(spec.components[0]?.id).toBe("root-node");
  });

  it("returns a snapshot whose prototypes are severed", () => {
    const spec = expectOk(validSpec({ data: { nested: { leaf: true } } }));
    expect(Object.getPrototypeOf(spec)).toBeNull();
    expect(Object.getPrototypeOf(spec.components[0])).toBeNull();
    expect(
      Object.getPrototypeOf((spec.data as Record<string, unknown>).nested),
    ).toBeNull();
  });

  it("normalizes negative zero in data to positive zero", () => {
    const spec = expectOk(validSpec({ data: { reading: -0 } }));
    const data = spec.data as Record<string, number>;
    expect(data.reading).toBe(0);
    expect(Object.is(data.reading, -0)).toBe(false);
  });

  it("accepts every component name in the frozen catalog", () => {
    for (const name of ELIZA_GENUI_ALLOWED_COMPONENTS) {
      const spec = expectOk({
        version: "0.1",
        root: `c-${name}`,
        components: [{ id: `c-${name}`, component: name }],
      });
      expect(spec.components[0]?.component).toBe(name);
    }
  });

  it("accepts child refs declared across every binding slot", () => {
    const spec = expectOk(
      validSpec({
        components: [
          {
            id: "panel",
            component: "Row",
            child: "alpha",
            children: ["beta", "gamma"],
            entryPointChild: "delta",
            contentChild: "epsilon",
            tabItems: [{ child: "zeta" }],
          },
          ...["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map(
            (id) => ({ id, component: "Text" }),
          ),
        ],
        root: "panel",
      }),
    );
    expect(spec.components).toHaveLength(7);
  });
});

describe("validateElizaGenUiSpec header validation", () => {
  it('rejects a version other than "0.1"', () => {
    const errors = expectErrors(validSpec({ version: "0.2" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("invalid_version");
    expect(errors[0]?.path).toBe("version");
  });

  it('accepts an explicit A2UI compatibility version of "0.9"', () => {
    const spec = expectOk(validSpec({ a2uiVersion: "0.9" }));
    expect(spec.a2uiVersion).toBe("0.9");
  });

  it("rejects any other provided A2UI compatibility version", () => {
    const errors = expectErrors(validSpec({ a2uiVersion: "1.0" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("invalid_version");
    expect(errors[0]?.path).toBe("a2uiVersion");
  });

  it("rejects a blank root id once in the header and again as a dangling ref", () => {
    const errors = expectErrors(validSpec({ root: "   " }));
    expect(errors.map((issue) => issue.code)).toEqual([
      "invalid_root",
      "invalid_root",
    ]);
    expect(errors[0]?.message).toContain("Root component id must be");
    expect(errors[1]?.message).toContain('"   "');
  });

  it("rejects non-object specs without throwing", () => {
    for (const value of [null, [], "spec", 42]) {
      const errors = expectErrors(value);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("invalid_spec");
    }
  });
});

describe("validateElizaGenUiSpec components array", () => {
  it("rejects a spec whose components are not an array", () => {
    const errors = expectErrors(validSpec({ components: {} }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("invalid_spec");
    expect(errors[0]?.path).toBe("components");
  });

  it("accepts exactly 200 components under the default cap", () => {
    const components = Array.from({ length: 200 }, (_, index) => ({
      id: `node-${index}`,
      component: "Text",
    }));
    const spec = expectOk(validSpec({ components, root: "node-0" }));
    expect(spec.components).toHaveLength(200);
  });

  it("rejects 201 components with too_many_components by default", () => {
    const components = Array.from({ length: 201 }, (_, index) => ({
      id: `node-${index}`,
      component: "Text",
    }));
    const errors = expectErrors(validSpec({ components, root: "node-0" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("too_many_components");
    expect(errors[0]?.message).toContain("201");
  });

  it("honors a lower maxComponents override", () => {
    const components = [
      { id: "one", component: "Text" },
      { id: "two", component: "Text" },
    ];
    const errors = expectErrors(validSpec({ components, root: "one" }), {
      maxComponents: 1,
    });
    expect(errors.map((issue) => issue.code)).toEqual(["too_many_components"]);
  });
});

describe("validateElizaGenUiSpec component records", () => {
  it("rejects a component without a usable id", () => {
    const errors = expectErrors(
      validSpec({
        components: [{ component: "Text" }],
        root: "nowhere",
      }),
    );
    expect(errors.map((issue) => issue.code)).toEqual([
      "invalid_component",
      "invalid_root",
    ]);
    expect(errors[0]?.message).toContain("id must be a non-empty string");
    expect(errors[0]?.path).toBe("components/0");
  });

  it("rejects a whitespace-only id", () => {
    const errors = expectErrors(
      validSpec({
        components: [{ id: "   ", component: "Text" }],
        root: "nowhere",
      }),
    );
    expect(errors.map((issue) => issue.code)).toEqual([
      "invalid_component",
      "invalid_root",
    ]);
  });

  it("rejects a duplicate id and reports the offending component", () => {
    const duplicated = { id: "twin", component: "Text" };
    const errors = expectErrors(
      validSpec({
        components: [duplicated, duplicated],
        root: "twin",
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("duplicate_id");
    expect(errors[0]?.componentId).toBe("twin");
    expect(errors[0]?.path).toBe("components/1");
  });

  it("rejects a blank component name", () => {
    const errors = expectErrors(
      validSpec({
        components: [{ id: "anon", component: "  " }],
        root: "anon",
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("invalid_component");
    expect(errors[0]?.message).toContain("Component name must be a non-empty");
    expect(errors[0]?.path).toBe("components/0/component");
  });

  it("flags component names outside the catalog as unknown", () => {
    const errors = expectErrors(
      validSpec({
        components: [{ id: "odd", component: "Bogus" }],
        root: "odd",
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("unknown_component");
    expect(errors[0]?.componentId).toBe("odd");
    expect(errors[0]?.path).toBe("components/0/component");
    expect(errors[0]?.message).toContain("Bogus");
  });
});

describe("validateElizaGenUiSpec image sources", () => {
  it.each([
    "/absolute.png",
    "./relative.png",
    "../parent.png",
    "data:image/png;base64,AAAA",
    "http://example.com/picture.png",
    "https://example.com/picture.png",
    "blob:generated-id",
    "assets/no-colon-relative.png",
  ])("accepts safe Image src %s", (src) => {
    expectOk(
      validSpec({
        components: [{ id: "img", component: "Image", src }],
        root: "img",
      }),
    );
  });

  it.each([
    "javascript:alert(1)",
    "ftp://example.com/picture.png",
    "data:text/html,<script>",
  ])("rejects unsafe Image src %s", (src) => {
    const errors = expectErrors(
      validSpec({
        components: [{ id: "img", component: "Image", src }],
        root: "img",
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("unsafe_url");
    expect(errors[0]?.componentId).toBe("img");
    expect(errors[0]?.path).toBe("components/0/src");
  });
});

describe("validateElizaGenUiSpec action allow-list", () => {
  function specWithAction(name: unknown, overrides: object = {}) {
    return validSpec({
      components: [
        {
          id: "button",
          component: "Button",
          action: { event: { name, ...overrides } },
        },
      ],
      root: "button",
    });
  }

  it("accepts event names matching an allowed prefix", () => {
    expectOk(specWithAction("setup.begin"));
    expectOk(specWithAction("voice.transcript.final"));
  });

  it("rejects event names outside every allowed prefix", () => {
    const errors = expectErrors(specWithAction("system.shutdown"));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("invalid_action");
    expect(errors[0]?.componentId).toBe("button");
    expect(errors[0]?.path).toBe("components/button/action/event/name");
  });

  it.each([{}, { event: null }, { event: {} }])(
    "rejects malformed action %j",
    (action) => {
      const value = validSpec({
        components: [{ id: "button", component: "Button", action }],
        root: "button",
      });
      const errors = expectErrors(value);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("invalid_action");
      expect(errors[0]?.message).toContain(
        "Action must use { event: { name, payload? } }",
      );
      expect(errors[0]?.path).toBe("components/button/action");
    },
  );

  it("rejects a blank event name even inside a well-formed action", () => {
    const errors = expectErrors(specWithAction("   "));
    expect(errors[0]?.code).toBe("invalid_action");
    expect(errors[0]?.message).toContain(
      "Action must use { event: { name, payload? } }",
    );
    expect(errors[0]?.path).toBe("components/button/action");
  });

  it("admits exact names listed in allowedActionNames", () => {
    const options = { allowedActionNames: ["app.custom"] };
    expectOk(specWithAction("app.custom"), options);
    const errors = expectErrors(specWithAction("app.custom"), {});
    expect(errors[0]?.code).toBe("invalid_action");
  });

  it("replaces the default prefixes when allowedActionPrefixes is set", () => {
    const options = { allowedActionPrefixes: ["app."] };
    expectOk(specWithAction("app.go"), options);
    const errors = expectErrors(specWithAction("setup.begin"), options);
    expect(errors[0]?.code).toBe("invalid_action");
  });
});

describe("validateElizaGenUiSpec reference integrity", () => {
  it("rejects a root that points at no declared component", () => {
    const errors = expectErrors(validSpec({ root: "ghost" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("invalid_root");
    expect(errors[0]?.message).toContain('"ghost"');
  });

  it("reports each missing child reference once", () => {
    const errors = expectErrors(
      validSpec({
        components: [
          { id: "row", component: "Row", children: ["here", "gone"] },
          { id: "here", component: "Text" },
        ],
        root: "row",
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("missing_child");
    expect(errors[0]?.message).toContain('"gone"');
  });

  it("accumulates every independent violation instead of stopping early", () => {
    const errors = expectErrors(
      validSpec({
        version: "9",
        root: "missing-root",
        components: [{ id: "odd", component: "Nope" }],
      }),
    );
    expect(errors.map((issue) => issue.code)).toEqual([
      "invalid_version",
      "unknown_component",
      "invalid_root",
    ]);
  });
});

describe("validateElizaGenUiSpec hostile payloads", () => {
  it("rejects cyclic data with unbounded_nest and never throws", () => {
    const data: Record<string, unknown> = {};
    data.self = data;
    const errors = expectErrors(validSpec({ data }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("unbounded_nest");
    expect(errors[0]?.message).toContain("cyclic");
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["function", () => "x"],
    ["symbol", Symbol("s")],
    ["bigint", 1n],
  ])("rejects a %s data value as invalid_spec", (_label, value) => {
    const errors = expectErrors(validSpec({ data: { field: value } }));
    expect(errors[0]?.code).toBe("invalid_spec");
    expect(errors[0]?.message).toContain("serializable JSON primitives");
  });

  it("flags script-bearing field names as unsafe_field", () => {
    const errors = expectErrors(
      validSpec({
        data: { onClick: "steal()", innerHTML: "<b>x</b>" },
      }),
    );
    const flagged = errors.filter((issue) => issue.code === "unsafe_field");
    expect(flagged.map((issue) => issue.path)).toEqual([
      "/data/onClick",
      "/data/innerHTML",
    ]);
  });

  it("skips symbol-keyed and non-enumerable properties silently", () => {
    const symbolKey = Symbol("hidden");
    const input: Record<PropertyKey, unknown> = {
      ...validSpec(),
      [symbolKey]: "ignored",
    };
    Object.defineProperty(input, "concealed", {
      value: "ignored",
      enumerable: false,
    });
    const spec = expectOk(input);
    expect(spec.version).toBe("0.1");
  });
});

describe("validateElizaGenUiSpec size options", () => {
  it("rejects a spec over a lowered maxJsonBytes override", () => {
    const errors = expectErrors(validSpec(), { maxJsonBytes: 16 });
    expect(errors[0]?.code).toBe("too_large");
    expect(errors[0]?.message).toContain("bytes");
  });

  it("keeps a small honest spec under a generous byte budget", () => {
    const spec = expectOk(validSpec(), { maxJsonBytes: 65_536 });
    expect(spec.root).toBe("root-node");
  });
});

describe("assertValidElizaGenUiSpec", () => {
  it("returns the validated spec on success", () => {
    const spec = assertValidElizaGenUiSpec(validSpec());
    expect(spec.root).toBe("root-node");
    expect(spec.components[0]?.component).toBe("Text");
  });

  it("throws one Error joining every issue message with newlines", () => {
    const invalid = validSpec({ version: "9" });
    const expected = validateElizaGenUiSpec(invalid);
    if (!expected.ok) {
      let thrown: unknown;
      try {
        assertValidElizaGenUiSpec(invalid);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        expected.errors.map((issue) => issue.message).join("\n"),
      );
    } else {
      throw new Error("fixture unexpectedly validated");
    }
  });
});
