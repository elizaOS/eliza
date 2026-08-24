/**
 * Pins fragment template id suffixing and the prompt renderer. The renderer
 * builds model-facing content, so the repository prompt-integrity rule applies:
 * every template must appear complete, with no cap or elision. The id helpers
 * are an encode/decode pair and must round-trip. NODE_ENV is saved and restored
 * per test; no harness.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import templates, {
  getTemplateId,
  getTemplateIdSuffix,
  type Templates,
  templatesToPrompt,
} from "./templates";

let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

describe("getTemplateIdSuffix", () => {
  test("appends -dev only under NODE_ENV=development", () => {
    process.env.NODE_ENV = "development";
    expect(getTemplateIdSuffix("nextjs-developer")).toBe("nextjs-developer-dev");
  });

  test("returns the id unchanged in every other environment", () => {
    for (const value of ["production", "test", "staging", ""]) {
      process.env.NODE_ENV = value;
      expect(getTemplateIdSuffix("nextjs-developer")).toBe("nextjs-developer");
    }
  });

  test("returns the id unchanged when NODE_ENV is unset", () => {
    delete process.env.NODE_ENV;
    expect(getTemplateIdSuffix("nextjs-developer")).toBe("nextjs-developer");
  });

  test("matches NODE_ENV exactly — no casing or whitespace tolerance", () => {
    for (const value of ["Development", "DEVELOPMENT", " development", "development "]) {
      process.env.NODE_ENV = value;
      expect(getTemplateIdSuffix("x")).toBe("x");
    }
  });
});

describe("getTemplateId", () => {
  test("strips a trailing -dev", () => {
    expect(getTemplateId("nextjs-developer-dev")).toBe("nextjs-developer");
  });

  test("leaves an id without the suffix alone", () => {
    expect(getTemplateId("nextjs-developer")).toBe("nextjs-developer");
    expect(getTemplateId("code-interpreter-v1")).toBe("code-interpreter-v1");
  });

  test("only strips at the end, not in the middle", () => {
    expect(getTemplateId("my-dev-app")).toBe("my-dev-app");
    expect(getTemplateId("dev-tools")).toBe("dev-tools");
  });

  test("strips exactly one suffix", () => {
    expect(getTemplateId("x-dev-dev")).toBe("x-dev");
  });

  test("handles the empty string", () => {
    expect(getTemplateId("")).toBe("");
  });
});

describe("id round-trip", () => {
  test("decode undoes encode in development", () => {
    process.env.NODE_ENV = "development";
    for (const id of [
      "code-interpreter-v1",
      "nextjs-developer",
      "vue-developer",
      "streamlit-developer",
      "gradio-developer",
    ]) {
      expect(getTemplateId(getTemplateIdSuffix(id))).toBe(id);
    }
  });

  test("decode undoes encode in production", () => {
    process.env.NODE_ENV = "production";
    for (const id of ["nextjs-developer", "vue-developer"]) {
      expect(getTemplateId(getTemplateIdSuffix(id))).toBe(id);
    }
  });
});

describe("template catalog", () => {
  const entries = Object.entries(templates);

  test("is non-empty and every id is unique", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(Object.keys(templates)).size).toBe(entries.length);
  });

  test("every template carries a usable shape", () => {
    for (const [id, t] of entries) {
      expect(id.length).toBeGreaterThan(0);
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.instructions.trim().length).toBeGreaterThan(0);
      expect(t.file.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(t.lib)).toBe(true);
      expect(t.lib.length).toBeGreaterThan(0);
    }
  });

  test("every port is either null or a valid TCP port", () => {
    for (const [, t] of entries) {
      if (t.port === null) continue;
      expect(Number.isInteger(t.port)).toBe(true);
      expect(t.port).toBeGreaterThan(0);
      expect(t.port).toBeLessThanOrEqual(65535);
    }
  });

  test("no dependency entry is blank", () => {
    for (const [, t] of entries) {
      for (const lib of t.lib) {
        expect(typeof lib).toBe("string");
        expect(lib.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("every catalog id decodes to a stable base id", () => {
    for (const id of Object.keys(templates)) {
      const base = getTemplateId(id);
      expect(base.length).toBeGreaterThan(0);
      expect(getTemplateId(base)).toBe(base);
    }
  });
});

describe("templatesToPrompt", () => {
  const fixture = {
    alpha: {
      name: "Alpha",
      lib: ["one", "two"],
      file: "a.py",
      instructions: "Does alpha things.",
      port: 8501,
    },
    beta: {
      name: "Beta",
      lib: ["three"],
      file: "",
      instructions: "Does beta things.",
      port: null,
    },
  } as unknown as Templates;

  test("numbers entries from one, in insertion order", () => {
    const lines = templatesToPromptLines(fixture);
    expect(lines[0].startsWith("1. alpha:")).toBe(true);
    expect(lines[1].startsWith("2. beta:")).toBe(true);
  });

  test("renders instructions, file, dependencies, and port", () => {
    const [first] = templatesToPromptLines(fixture);
    expect(first).toContain('"Does alpha things."');
    expect(first).toContain("File: a.py");
    expect(first).toContain("Dependencies installed: one, two");
    expect(first).toContain("Port: 8501");
  });

  test("substitutes 'none' for a missing file or port", () => {
    const [, second] = templatesToPromptLines(fixture);
    expect(second).toContain("File: none");
    expect(second).toContain("Port: none");
  });

  test("emits exactly one line per template, with no trailing newline", () => {
    const rendered = templatesToPrompt(fixture);
    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered.endsWith("\n")).toBe(false);
  });

  test("renders the real catalog completely, with no elision", () => {
    const rendered = templatesToPrompt(templates);
    const ids = Object.keys(templates);
    expect(rendered.split("\n")).toHaveLength(ids.length);
    for (const id of ids) expect(rendered).toContain(`${id}:`);
    expect(rendered).not.toContain("…");
    expect(rendered).not.toMatch(/truncat/i);
  });

  test("carries every dependency of every template through", () => {
    const rendered = templatesToPrompt(templates);
    for (const t of Object.values(templates)) {
      for (const lib of t.lib) expect(rendered).toContain(lib);
    }
  });

  test("does not cap a long catalog", () => {
    const many = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `tpl-${i}`,
        {
          name: `T${i}`,
          lib: [`lib-${i}`],
          file: `f${i}.py`,
          instructions: `I${i}`,
          port: null,
        },
      ]),
    ) as unknown as Templates;
    const rendered = templatesToPrompt(many);
    expect(rendered.split("\n")).toHaveLength(200);
    expect(rendered).toContain("200. tpl-199:");
    expect(rendered).toContain("lib-199");
  });

  test("returns an empty string for an empty catalog", () => {
    expect(templatesToPrompt({} as unknown as Templates)).toBe("");
  });

  test("is deterministic", () => {
    expect(templatesToPrompt(templates)).toBe(templatesToPrompt(templates));
  });
});

function templatesToPromptLines(input: Templates): string[] {
  return templatesToPrompt(input).split("\n");
}
