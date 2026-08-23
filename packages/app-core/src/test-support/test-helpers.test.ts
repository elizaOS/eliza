/**
 * Direct unit coverage for app-core test-support helpers. Drives the real
 * module: plugin-shape predicates, export extraction order, package and
 * filesystem plugin resolvers, `waitMs`, and the lightweight HTTP
 * request/response factories. Does not mock the system under test.
 */
import { existsSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
  extractPlugin,
  isPackageImportResolvable,
  looksLikePlugin,
  type PluginModuleShape,
  resolveFarcasterPluginImportSpecifier,
  resolveFeishuPluginImportSpecifier,
  resolveLensPluginImportSpecifier,
  resolveMatrixPluginImportSpecifier,
  resolveNostrPluginImportSpecifier,
  resolveTelegramPluginImportSpecifier,
  waitMs,
} from "./test-helpers";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function existingFileHref(absolutePath: string): string | null {
  return existsSync(absolutePath) ? pathToFileURL(absolutePath).href : null;
}

function expectedPluginSpecifier({
  packageNames,
  nodeModulesEntries,
  localEntries,
}: {
  packageNames: readonly string[];
  nodeModulesEntries?: readonly {
    packageName: string;
    relativeEntryPath: string;
  }[];
  localEntries?: readonly string[];
}): string | null {
  for (const packageName of packageNames) {
    if (isPackageImportResolvable(packageName)) {
      return packageName;
    }
  }
  for (const entry of nodeModulesEntries ?? []) {
    const href = existingFileHref(
      path.resolve(
        PACKAGE_ROOT,
        "node_modules",
        ...entry.packageName.split("/"),
        entry.relativeEntryPath,
      ),
    );
    if (href) return href;
  }
  for (const relativeEntryPath of localEntries ?? []) {
    const href = existingFileHref(
      path.resolve(PACKAGE_ROOT, relativeEntryPath),
    );
    if (href) return href;
  }
  return null;
}

async function collectRequestChunks(
  req: http.IncomingMessage,
): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  return chunks;
}

describe("looksLikePlugin", () => {
  it("rejects null, undefined, and non-objects", () => {
    expect(looksLikePlugin(null)).toBe(false);
    expect(looksLikePlugin(undefined)).toBe(false);
    expect(looksLikePlugin("plugin")).toBe(false);
    expect(looksLikePlugin(1)).toBe(false);
    expect(looksLikePlugin(true)).toBe(false);
  });

  it("rejects functions even when Function.name is a non-empty string", () => {
    function namedExport() {}
    expect(namedExport.name).toBe("namedExport");
    expect(looksLikePlugin(namedExport)).toBe(false);
  });

  it("rejects objects whose name is missing or not a string", () => {
    expect(looksLikePlugin({})).toBe(false);
    expect(looksLikePlugin({ Name: "wrong-case" })).toBe(false);
    expect(looksLikePlugin({ name: 42 })).toBe(false);
    expect(looksLikePlugin({ name: null })).toBe(false);
    expect(looksLikePlugin({ name: undefined })).toBe(false);
    expect(looksLikePlugin([])).toBe(false);
  });

  it("accepts a plain object whose name is a string, including empty", () => {
    expect(looksLikePlugin({ name: "telegram" })).toBe(true);
    expect(looksLikePlugin({ name: "" })).toBe(true);
    expect(looksLikePlugin({ name: "x", extra: 1 })).toBe(true);
  });
});

describe("extractPlugin", () => {
  it("returns null for an empty module and for modules with no plugin-shaped export", () => {
    expect(extractPlugin({})).toBeNull();
    expect(
      extractPlugin({
        default: { not: "a-plugin" },
        plugin: 1,
        helper: () => undefined,
      }),
    ).toBeNull();
  });

  it("prefers default over plugin when both look like plugins", () => {
    const mod: PluginModuleShape = {
      default: { name: "from-default" },
      plugin: { name: "from-plugin" },
    };
    expect(extractPlugin(mod)).toEqual({ name: "from-default" });
  });

  it("uses plugin when default is present but not plugin-shaped", () => {
    const mod: PluginModuleShape = {
      default: { name: 1 },
      plugin: { name: "from-plugin" },
    };
    expect(extractPlugin(mod)).toEqual({ name: "from-plugin" });
  });

  it("returns the module itself when it has a string name, before scanning other keys", () => {
    const nested = { name: "nested" };
    const mod: PluginModuleShape = {
      name: "root-module",
      other: nested,
    };
    expect(extractPlugin(mod)).toBe(mod);
  });

  it("skips default and plugin keys while scanning remaining exports, and returns the first insertion-order match", () => {
    const first = { name: "first-named" };
    const second = { name: "second-named" };
    const mod: PluginModuleShape = {
      default: { name: 0 },
      plugin: { nope: true },
      first,
      second,
    };
    expect(extractPlugin(mod)).toBe(first);
  });

  it("returns null rather than a missing nested item when no export matches", () => {
    expect(
      extractPlugin({
        default: undefined,
        plugin: undefined,
        actions: [],
      }),
    ).toBeNull();
  });
});

describe("isPackageImportResolvable", () => {
  it("returns true for packages that Node can resolve from this module", () => {
    expect(isPackageImportResolvable("vitest")).toBe(true);
    expect(isPackageImportResolvable("@elizaos/core")).toBe(true);
  });

  it("returns false for an empty name and for a package that does not exist", () => {
    expect(isPackageImportResolvable("")).toBe(false);
    expect(
      isPackageImportResolvable(
        "@elizaos/this-package-is-not-installed-9f3a2c1b",
      ),
    ).toBe(false);
  });
});

describe("plugin import specifiers", () => {
  it("resolves Telegram in package-name, node_modules dist, then local-checkout order", () => {
    expect(resolveTelegramPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-telegram"],
        nodeModulesEntries: [
          {
            packageName: "@elizaos/plugin-telegram",
            relativeEntryPath: "dist/index.js",
          },
        ],
        localEntries: ["../plugins/plugin-telegram/dist/index"],
      }),
    );
  });

  it("resolves Lens with the canonical name, then the client-lens fallback, then filesystem probes", () => {
    expect(resolveLensPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-lens", "@elizaos-plugins/client-lens"],
        nodeModulesEntries: [
          {
            packageName: "@elizaos-plugins/client-lens",
            relativeEntryPath: "src/index.ts",
          },
          {
            packageName: "@elizaos-plugins/client-lens",
            relativeEntryPath: "dist/index.js",
          },
        ],
        localEntries: [
          "../plugins/plugin-lens/dist/index",
          "../../client-lens/dist/index",
          "../../client-lens/src/index",
        ],
      }),
    );
  });

  it("resolves Farcaster from the package name, then the local node dist entry", () => {
    expect(resolveFarcasterPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-farcaster"],
        localEntries: ["../plugins/plugin-farcaster/dist/node/index.node.js"],
      }),
    );
  });

  it("resolves Nostr from the package name, then the local dist entry", () => {
    expect(resolveNostrPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-nostr"],
        localEntries: ["../plugins/plugin-nostr/dist/index"],
      }),
    );
  });

  it("resolves Matrix from the package name, then the local dist entry", () => {
    expect(resolveMatrixPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-matrix"],
        localEntries: ["../plugins/plugin-matrix/dist/index"],
      }),
    );
  });

  it("resolves Feishu in package-name, node_modules dist, then local-checkout order", () => {
    expect(resolveFeishuPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-feishu"],
        nodeModulesEntries: [
          {
            packageName: "@elizaos/plugin-feishu",
            relativeEntryPath: "dist/index.js",
          },
        ],
        localEntries: ["../plugins/plugin-feishu/dist/index"],
      }),
    );
  });

  it("returns a resolvable package name, an existing file URL, or null", () => {
    const specifiers = [
      resolveTelegramPluginImportSpecifier(),
      resolveLensPluginImportSpecifier(),
      resolveFarcasterPluginImportSpecifier(),
      resolveNostrPluginImportSpecifier(),
      resolveMatrixPluginImportSpecifier(),
      resolveFeishuPluginImportSpecifier(),
    ];
    for (const specifier of specifiers) {
      if (specifier === null) continue;
      if (specifier.startsWith("file:")) {
        expect(existsSync(fileURLToPath(specifier))).toBe(true);
      } else {
        expect(isPackageImportResolvable(specifier)).toBe(true);
      }
    }
  });
});

describe("waitMs", () => {
  it("resolves with undefined for a zero delay", async () => {
    await expect(waitMs(0)).resolves.toBeUndefined();
  });

  it("does not resolve before the requested delay elapses", async () => {
    const started = Date.now();
    await waitMs(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});

describe("createMockHttpResponse", () => {
  it("starts at HTTP 200 with an empty body, so getJson returns null", () => {
    const mock = createMockHttpResponse();
    expect(mock.getStatus()).toBe(200);
    expect(mock.getJson()).toBeNull();
    expect(mock.res._status).toBe(0);
    expect(mock.res._body).toBe("");
  });

  it("records writeHead on getStatus immediately, and copies it onto _status only at end", () => {
    const mock = createMockHttpResponse();
    mock.res.writeHead(404);
    expect(mock.getStatus()).toBe(404);
    expect(mock.res._status).toBe(0);
    mock.res.end();
    expect(mock.res._status).toBe(404);
    expect(mock.getJson()).toBeNull();
  });

  it("records a statusCode assignment on getStatus", () => {
    const mock = createMockHttpResponse();
    mock.res.statusCode = 201;
    expect(mock.getStatus()).toBe(201);
    expect(mock.res.statusCode).toBe(201);
  });

  it("parses a JSON body supplied to end, including Buffer payloads", () => {
    const objectBody = createMockHttpResponse<{ ok: boolean }>();
    objectBody.res.end(JSON.stringify({ ok: true }));
    expect(objectBody.getJson()).toEqual({ ok: true });
    expect(objectBody.res._body).toBe(JSON.stringify({ ok: true }));

    const bufferBody = createMockHttpResponse<{ n: number }>();
    bufferBody.res.end(Buffer.from('{"n":3}', "utf-8"));
    expect(bufferBody.getJson()).toEqual({ n: 3 });
  });

  it("throws when getJson is asked to parse a non-JSON body", () => {
    const mock = createMockHttpResponse();
    mock.res.end("not-json");
    expect(() => mock.getJson()).toThrow(SyntaxError);
  });

  it("treats setHeader as a no-op", () => {
    const mock = createMockHttpResponse();
    expect(
      mock.res.setHeader("content-type", "application/json"),
    ).toBeUndefined();
    expect(mock.getStatus()).toBe(200);
  });
});

describe("createMockIncomingMessage", () => {
  it("defaults to GET / with the localhost host header and emits end with no body", async () => {
    const req = createMockIncomingMessage({});
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/");
    expect(req.headers).toEqual({ host: "localhost:2138" });
    const chunks = await collectRequestChunks(req);
    expect(chunks).toEqual([]);
  });

  it("emits a string body as a single utf-8 chunk", async () => {
    const req = createMockIncomingMessage({
      method: "POST",
      url: "/api",
      body: "hello",
    });
    const chunks = await collectRequestChunks(req);
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("hello");
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api");
  });

  it("emits a Buffer body unchanged", async () => {
    const payload = Buffer.from([1, 2, 3]);
    const req = createMockIncomingMessage({ body: payload });
    const chunks = await collectRequestChunks(req);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].equals(payload)).toBe(true);
  });

  it("JSON-stringifies a non-string body only when json is true", async () => {
    const jsonReq = createMockIncomingMessage({
      body: { a: 1 },
      json: true,
    });
    const jsonChunks = await collectRequestChunks(jsonReq);
    expect(Buffer.concat(jsonChunks).toString("utf-8")).toBe(
      JSON.stringify({ a: 1 }),
    );

    const stringifiedReq = createMockIncomingMessage({
      body: { a: 1 },
      json: false,
    });
    const stringifiedChunks = await collectRequestChunks(stringifiedReq);
    expect(Buffer.concat(stringifiedChunks).toString("utf-8")).toBe(
      String({ a: 1 }),
    );
  });

  it("prefers bodyChunks over body, including an empty chunk list", async () => {
    const mixed = createMockIncomingMessage({
      body: "ignored",
      bodyChunks: ["one", Buffer.from("two", "utf-8")],
    });
    const mixedChunks = await collectRequestChunks(mixed);
    expect(mixedChunks.map((chunk) => chunk.toString("utf-8"))).toEqual([
      "one",
      "two",
    ]);

    const emptyQueue = createMockIncomingMessage({
      body: "ignored",
      bodyChunks: [],
    });
    const emptyChunks = await collectRequestChunks(emptyQueue);
    expect(emptyChunks).toEqual([]);
  });

  it("returns the request from destroy and does not prevent the end event", async () => {
    const req = createMockIncomingMessage({ body: "x" });
    expect(req.destroy()).toBe(req);
    expect(req.destroy(new Error("unused"))).toBe(req);
    const chunks = await collectRequestChunks(req);
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("x");
  });

  it("uses caller headers instead of the default host header", () => {
    const req = createMockIncomingMessage({
      headers: { host: "example.test", "x-test": "1" },
    });
    expect(req.headers).toEqual({ host: "example.test", "x-test": "1" });
  });
});
