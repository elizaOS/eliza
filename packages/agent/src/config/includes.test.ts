/**
 * Behavioral coverage for $include resolution: merge, cycles, depth, budgets,
 * invalid shapes, blocked keys, and the production filesystem resolver.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CircularIncludeError,
  ConfigIncludeError,
  deepMerge,
  INCLUDE_KEY,
  type IncludeResolver,
  MAX_INCLUDE_DEPTH,
  resolveConfigIncludes,
} from "./includes.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-includes-"));
  roots.push(root);
  return root;
}

function memoryResolver(files: Map<string, string>): IncludeResolver {
  return {
    readFile: (file) => {
      const raw = files.get(path.normalize(file));
      if (raw === undefined) throw new Error(`missing ${file}`);
      return raw;
    },
    parseJson: JSON.parse,
  };
}

function resolveMemory(
  obj: unknown,
  files: Map<string, string>,
  configPath = "/cfg/root.json5",
): unknown {
  return resolveConfigIncludes(obj, configPath, memoryResolver(files));
}

describe("include constants and errors", () => {
  it("exports the $include key and a depth cap of 10", () => {
    expect(INCLUDE_KEY).toBe("$include");
    expect(MAX_INCLUDE_DEPTH).toBe(10);
  });

  it("preserves includePath and optional cause on ConfigIncludeError", () => {
    const cause = new Error("disk");
    const err = new ConfigIncludeError("failed", "./missing.json5", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ConfigIncludeError");
    expect(err.message).toBe("failed");
    expect(err.includePath).toBe("./missing.json5");
    expect(err.cause).toBe(cause);
    expect(new ConfigIncludeError("no cause", "x").cause).toBeUndefined();
  });

  it("CircularIncludeError records the chain and uses the last hop as includePath", () => {
    const chain = ["/cfg/a.json5", "/cfg/b.json5", "/cfg/a.json5"];
    const err = new CircularIncludeError(chain);
    expect(err).toBeInstanceOf(ConfigIncludeError);
    expect(err.name).toBe("CircularIncludeError");
    expect(err.chain).toEqual(chain);
    expect(err.includePath).toBe("/cfg/a.json5");
    expect(err.message).toBe(
      "Circular include detected: /cfg/a.json5 -> /cfg/b.json5 -> /cfg/a.json5",
    );
    expect(new CircularIncludeError([]).includePath).toBe("");
  });
});

describe("deepMerge", () => {
  it("concatenates arrays and does not mutate the inputs", () => {
    const target = [1];
    const source = [2, 3];
    expect(deepMerge(target, source)).toEqual([1, 2, 3]);
    expect(target).toEqual([1]);
    expect(source).toEqual([2, 3]);
    expect(deepMerge([], [])).toEqual([]);
    expect(deepMerge(["only"], [])).toEqual(["only"]);
    expect(deepMerge([], ["only"])).toEqual(["only"]);
  });

  it("merges nested objects left-to-right, with later primitives winning ties", () => {
    expect(
      deepMerge(
        { a: 1, nested: { x: 1, keep: true }, extra: "stay" },
        { a: 2, nested: { x: 2, y: 3 }, added: 4 },
      ),
    ).toEqual({
      a: 2,
      nested: { x: 2, keep: true, y: 3 },
      extra: "stay",
      added: 4,
    });
  });

  it("skips prototype-polluting keys on the source object", () => {
    const source: Record<string, unknown> = {
      safe: 1,
      constructor: { pwned: true },
      prototype: { pwned: true },
    };
    Object.defineProperty(source, "__proto__", {
      value: { pwned: true },
      enumerable: true,
      configurable: true,
    });
    expect(deepMerge({ keep: true }, source)).toEqual({ keep: true, safe: 1 });
  });

  it("returns the source when the types cannot merge", () => {
    expect(deepMerge({ a: 1 }, 2)).toBe(2);
    expect(deepMerge([1], { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, [2])).toEqual([2]);
    expect(deepMerge(1, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge("a", "b")).toBe("b");
    expect(deepMerge(null, "x")).toBe("x");
    expect(deepMerge(undefined, false)).toBe(false);
  });
});

describe("resolveConfigIncludes without $include", () => {
  it("returns primitives, null, and empty collections unchanged", () => {
    const files = new Map<string, string>();
    expect(resolveMemory("hello", files)).toBe("hello");
    expect(resolveMemory(0, files)).toBe(0);
    expect(resolveMemory(true, files)).toBe(true);
    expect(resolveMemory(null, files)).toBeNull();
    expect(resolveMemory([], files)).toEqual([]);
    expect(resolveMemory({}, files)).toEqual({});
  });

  it("walks arrays and nested objects and drops blocked keys", () => {
    const input: Record<string, unknown> = {
      keep: { inner: 1 },
      list: [{ n: 1 }, "x", null],
      constructor: { pwned: true },
      prototype: { pwned: true },
    };
    Object.defineProperty(input, "__proto__", {
      value: { pwned: true },
      enumerable: true,
      configurable: true,
    });
    expect(resolveMemory(input, new Map())).toEqual({
      keep: { inner: 1 },
      list: [{ n: 1 }, "x", null],
    });
  });
});

describe("resolveConfigIncludes string and array $include", () => {
  it("loads a single relative include and an empty include array", () => {
    const files = new Map<string, string>([
      [path.normalize("/cfg/child.json5"), JSON.stringify({ enabled: true })],
    ]);
    expect(resolveMemory({ $include: "./child.json5" }, files)).toEqual({
      enabled: true,
    });
    expect(resolveMemory({ $include: [] }, files)).toEqual({});
  });

  it("resolves an absolute include path without joining the config directory", () => {
    const abs = path.normalize("/elsewhere/base.json5");
    const files = new Map<string, string>([
      [abs, JSON.stringify({ from: "abs" })],
    ]);
    expect(resolveMemory({ $include: abs }, files, "/cfg/root.json5")).toEqual({
      from: "abs",
    });
  });

  it("merges array includes left-to-right, concatenating nested arrays", () => {
    const files = new Map<string, string>([
      [
        path.normalize("/cfg/a.json5"),
        JSON.stringify({ k: 1, arr: [1], keep: true }),
      ],
      [
        path.normalize("/cfg/b.json5"),
        JSON.stringify({ k: 2, arr: [2], extra: 3 }),
      ],
    ]);
    expect(
      resolveMemory({ $include: ["./a.json5", "./b.json5"] }, files),
    ).toEqual({
      k: 2,
      arr: [1, 2],
      keep: true,
      extra: 3,
    });
  });

  it("treats a single-element include array as one merge into {}", () => {
    const files = new Map<string, string>([
      [path.normalize("/cfg/only.json5"), JSON.stringify({ only: true })],
    ]);
    expect(resolveMemory({ $include: ["./only.json5"] }, files)).toEqual({
      only: true,
    });
  });

  it("rejects non-string array items and invalid $include values", () => {
    const files = new Map<string, string>();
    expect(() => resolveMemory({ $include: [1] }, files)).toThrow(
      /Invalid \$include array item: expected string, got number/,
    );
    expect(() => resolveMemory({ $include: [null] }, files)).toThrow(
      /Invalid \$include array item: expected string, got object/,
    );
    expect(() =>
      resolveMemory({ $include: [{ path: "./x.json5" }] }, files),
    ).toThrow(/Invalid \$include array item: expected string, got object/);
    expect(() => resolveMemory({ $include: 3 }, files)).toThrow(
      /Invalid \$include value: expected string or array of strings, got number/,
    );
    expect(() => resolveMemory({ $include: true }, files)).toThrow(
      /got boolean/,
    );
    expect(() => resolveMemory({ $include: { path: "x" } }, files)).toThrow(
      /got object/,
    );
    expect(() => resolveMemory({ $include: null }, files)).toThrow(
      /got object/,
    );

    try {
      resolveMemory({ $include: [2] }, files);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      expect((err as ConfigIncludeError).includePath).toBe("2");
    }
  });

  it("resolves nested $include values inside objects and arrays", () => {
    const files = new Map<string, string>([
      [path.normalize("/cfg/inner.json5"), JSON.stringify({ inner: true })],
      [path.normalize("/cfg/item.json5"), JSON.stringify({ item: 1 })],
    ]);
    expect(
      resolveMemory(
        {
          nested: { $include: "./inner.json5" },
          list: [{ $include: "./item.json5" }],
        },
        files,
      ),
    ).toEqual({
      nested: { inner: true },
      list: [{ item: 1 }],
    });
  });
});

describe("resolveConfigIncludes sibling keys", () => {
  it("deep-merges sibling keys over included objects, processing nested includes", () => {
    const files = new Map<string, string>([
      [
        path.normalize("/cfg/base.json5"),
        JSON.stringify({ a: 1, nested: { x: 1 } }),
      ],
      [
        path.normalize("/cfg/over.json5"),
        JSON.stringify({ fromInclude: true }),
      ],
    ]);
    expect(
      resolveMemory(
        {
          $include: "./base.json5",
          a: 2,
          nested: { y: 2 },
          extra: { $include: "./over.json5" },
        },
        files,
      ),
    ).toEqual({
      a: 2,
      nested: { x: 1, y: 2 },
      extra: { fromInclude: true },
    });
  });

  it("rejects sibling keys when the included value is not an object", () => {
    const files = new Map<string, string>([
      [path.normalize("/cfg/list.json5"), JSON.stringify([1, 2])],
      [path.normalize("/cfg/num.json5"), JSON.stringify(4)],
    ]);
    expect(() =>
      resolveMemory({ $include: "./list.json5", extra: 1 }, files),
    ).toThrow(/Sibling keys require included content to be an object/);
    try {
      resolveMemory({ $include: "./num.json5", extra: 1 }, files);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      expect((err as ConfigIncludeError).includePath).toBe("./num.json5");
    }
    try {
      resolveMemory({ $include: ["./list.json5"], extra: 1 }, files);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      expect((err as ConfigIncludeError).includePath).toBe(INCLUDE_KEY);
    }
  });
});

describe("resolveConfigIncludes cycles, missing files, and parse failures", () => {
  it("detects a self-include and an A→B→A cycle, including normalized aliases", () => {
    const files = new Map<string, string>([
      [
        path.normalize("/cfg/self.json5"),
        JSON.stringify({ $include: "./self.json5" }),
      ],
      [
        path.normalize("/cfg/a.json5"),
        JSON.stringify({ $include: "./b.json5" }),
      ],
      [
        path.normalize("/cfg/b.json5"),
        JSON.stringify({ $include: "./nested/../a.json5" }),
      ],
    ]);
    expect(() =>
      resolveConfigIncludes(
        { $include: "./self.json5" },
        "/cfg/self.json5",
        memoryResolver(files),
      ),
    ).toThrow(CircularIncludeError);

    try {
      resolveMemory({ $include: "./a.json5" }, files);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CircularIncludeError);
      const circular = err as CircularIncludeError;
      expect(circular.chain.at(-1)).toBe(path.normalize("/cfg/a.json5"));
      expect(circular.message).toMatch(/Circular include detected:/);
    }
  });

  it("wraps read failures, including non-Error throws, and does not skip a missing file", () => {
    const files = new Map<string, string>();
    try {
      resolveMemory({ $include: "./missing.json5" }, files);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      const includeErr = err as ConfigIncludeError;
      expect(includeErr.message).toMatch(
        /Failed to read include file: \.\/missing\.json5/,
      );
      expect(includeErr.includePath).toBe("./missing.json5");
      expect(includeErr.cause).toBeInstanceOf(Error);
    }

    const throwing: IncludeResolver = {
      readFile: () => {
        throw "not-an-error";
      },
      parseJson: JSON.parse,
    };
    try {
      resolveConfigIncludes(
        { $include: "./x.json5" },
        "/cfg/root.json5",
        throwing,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      expect((err as ConfigIncludeError).cause).toBeUndefined();
    }
  });

  it("wraps parse failures and drops a non-Error parser throw", () => {
    const files = new Map<string, string>([
      [path.normalize("/cfg/bad.json5"), "{ not json"],
    ]);
    try {
      resolveMemory({ $include: "./bad.json5" }, files);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      const includeErr = err as ConfigIncludeError;
      expect(includeErr.message).toMatch(
        /Failed to parse include file: \.\/bad\.json5/,
      );
      expect(includeErr.cause).toBeInstanceOf(Error);
    }

    const throwing: IncludeResolver = {
      readFile: () => "{}",
      parseJson: () => {
        throw "parse-blew";
      },
    };
    try {
      resolveConfigIncludes(
        { $include: "./x.json5" },
        "/cfg/root.json5",
        throwing,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      expect((err as ConfigIncludeError).cause).toBeUndefined();
    }
  });
});

describe("resolveConfigIncludes depth and graph budgets", () => {
  it("allows a chain of MAX_INCLUDE_DEPTH includes and rejects one more", () => {
    const files = new Map<string, string>();
    for (let i = 1; i <= MAX_INCLUDE_DEPTH; i += 1) {
      files.set(
        path.normalize(`/cfg/d${i}.json5`),
        JSON.stringify({ $include: `./d${i + 1}.json5` }),
      );
    }
    files.set(
      path.normalize(`/cfg/d${MAX_INCLUDE_DEPTH}.json5`),
      JSON.stringify({ ok: true }),
    );
    expect(resolveMemory({ $include: "./d1.json5" }, files)).toEqual({
      ok: true,
    });

    files.set(
      path.normalize(`/cfg/d${MAX_INCLUDE_DEPTH}.json5`),
      JSON.stringify({ $include: `./d${MAX_INCLUDE_DEPTH + 1}.json5` }),
    );
    files.set(
      path.normalize(`/cfg/d${MAX_INCLUDE_DEPTH + 1}.json5`),
      JSON.stringify({ too: "deep" }),
    );
    try {
      resolveMemory({ $include: "./d1.json5" }, files);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      expect(err).not.toBeInstanceOf(CircularIncludeError);
      const includeErr = err as ConfigIncludeError;
      expect(includeErr.message).toBe(
        `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ./d${MAX_INCLUDE_DEPTH + 1}.json5`,
      );
      expect(includeErr.includePath).toBe(`./d${MAX_INCLUDE_DEPTH + 1}.json5`);
    }
  });

  it("rejects a single include over 1 MiB after the resolver returns it", () => {
    const oversized = "x".repeat(1_048_577);
    const files = new Map<string, string>([
      [path.normalize("/cfg/big.json5"), oversized],
    ]);
    const resolver: IncludeResolver = {
      readFile: (file) => {
        const raw = files.get(path.normalize(file));
        if (raw === undefined) throw new Error(`missing ${file}`);
        return raw;
      },
      parseJson: () => ({}),
    };
    expect(() =>
      resolveConfigIncludes(
        { $include: "./big.json5" },
        "/cfg/root.json5",
        resolver,
      ),
    ).toThrow(/Include file exceeds 1048576 bytes at: \.\/big\.json5/);
  });

  it("rejects a graph of 257 files even when each file is tiny", () => {
    const files = new Map<string, string>();
    const names: string[] = [];
    for (let i = 0; i < 257; i += 1) {
      const name = `./f${i}.json5`;
      names.push(name);
      files.set(path.normalize(`/cfg/f${i}.json5`), "{}");
    }
    const resolver: IncludeResolver = {
      readFile: (file) => files.get(path.normalize(file)) ?? "{}",
      parseJson: () => ({}),
    };
    expect(() =>
      resolveConfigIncludes({ $include: names }, "/cfg/root.json5", resolver),
    ).toThrow(/Include graph exceeds 256 files or 8388608 bytes/);
  });

  it("rejects an aggregate byte budget overflow across files under the per-file cap", () => {
    const chunk = "x".repeat(1_000_000);
    const files = new Map<string, string>();
    const names: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      names.push(`./c${i}.json5`);
      files.set(path.normalize(`/cfg/c${i}.json5`), chunk);
    }
    const resolver: IncludeResolver = {
      readFile: (file) => {
        const raw = files.get(path.normalize(file));
        if (raw === undefined) throw new Error(`missing ${file}`);
        return raw;
      },
      parseJson: () => ({}),
    };
    expect(() =>
      resolveConfigIncludes({ $include: names }, "/cfg/root.json5", resolver),
    ).toThrow(/Include graph exceeds 256 files or 8388608 bytes/);
  });
});

describe("resolveConfigIncludes production filesystem resolver", () => {
  it("parses JSON5 with comments and unquoted keys", () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, "child.json5"),
      `{
        // comment
        enabled: true,
      }`,
    );
    expect(
      resolveConfigIncludes(
        { $include: "./child.json5" },
        path.join(root, "root.json5"),
      ),
    ).toEqual({ enabled: true });
  });

  it("follows a relative nested include on disk", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(
      path.join(root, "nested", "leaf.json5"),
      JSON.stringify({ leaf: true }),
    );
    fs.writeFileSync(
      path.join(root, "mid.json5"),
      JSON.stringify({ $include: "./nested/leaf.json5" }),
    );
    expect(
      resolveConfigIncludes(
        { $include: "./mid.json5", extra: 1 },
        path.join(root, "root.json5"),
      ),
    ).toEqual({ leaf: true, extra: 1 });
  });

  it("wraps a missing file and a directory include as ConfigIncludeError", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "not-a-file"));
    expect(() =>
      resolveConfigIncludes(
        { $include: "./absent.json5" },
        path.join(root, "root.json5"),
      ),
    ).toThrow(ConfigIncludeError);
    expect(() =>
      resolveConfigIncludes(
        { $include: "./not-a-file" },
        path.join(root, "root.json5"),
      ),
    ).toThrow(ConfigIncludeError);
  });

  it("detects a real-filesystem include cycle", () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, "a.json5"),
      JSON.stringify({ $include: "./b.json5" }),
    );
    fs.writeFileSync(
      path.join(root, "b.json5"),
      JSON.stringify({ $include: "./a.json5" }),
    );
    expect(() =>
      resolveConfigIncludes(
        { $include: "./a.json5" },
        path.join(root, "root.json5"),
      ),
    ).toThrow(CircularIncludeError);
  });
});
