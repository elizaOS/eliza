/**
 * Contract tests for the load-apps-from-directory route Zod schemas: the structural request and
 * success response carrying registered items plus rejected-manifest diagnostics. Host-native path
 * semantics are exercised by the server route tests.
 */
import { describe, expect, it } from "vitest";
import {
  PostLoadFromDirectoryRequestSchema,
  PostLoadFromDirectoryResponseSchema,
} from "./apps-loading-routes.js";

describe("PostLoadFromDirectoryRequestSchema", () => {
  it("accepts an absolute POSIX path", () => {
    const parsed = PostLoadFromDirectoryRequestSchema.parse({
      directory: "/tmp/apps",
    });
    expect(parsed.directory).toBe("/tmp/apps");
  });

  it("leaves host-native path validation to the server boundary", () => {
    expect(
      PostLoadFromDirectoryRequestSchema.parse({ directory: "apps" }).directory,
    ).toBe("apps");
    expect(
      PostLoadFromDirectoryRequestSchema.parse({ directory: "C:\\apps" })
        .directory,
    ).toBe("C:\\apps");
  });

  it("rejects an empty string", () => {
    expect(() =>
      PostLoadFromDirectoryRequestSchema.parse({ directory: "" }),
    ).toThrow(/required/);
  });

  it("rejects a missing directory field", () => {
    expect(() => PostLoadFromDirectoryRequestSchema.parse({})).toThrow();
  });

  it("rejects a non-string directory", () => {
    expect(() =>
      PostLoadFromDirectoryRequestSchema.parse({ directory: 42 }),
    ).toThrow();
  });

  it("rejects extra unknown fields (strict)", () => {
    expect(() =>
      PostLoadFromDirectoryRequestSchema.parse({
        directory: "/tmp/x",
        force: true,
      }),
    ).toThrow();
  });
});

describe("PostLoadFromDirectoryResponseSchema", () => {
  const VALID_RESPONSE = {
    ok: true as const,
    directory: "/tmp/apps",
    registered: 2,
    items: [
      { slug: "foo", canonicalName: "@example/app-foo" },
      { slug: "bar", canonicalName: "@example/app-bar" },
    ],
    rejectedManifests: [
      {
        directory: "/tmp/apps/baz",
        packageName: "@example/app-baz",
        reason: "fs.read must be an array of glob strings",
        path: "permissions.fs.read",
      },
    ],
  };

  it("accepts a fully populated response", () => {
    const parsed = PostLoadFromDirectoryResponseSchema.parse(VALID_RESPONSE);
    expect(parsed).toEqual(VALID_RESPONSE);
  });

  it("accepts empty items + empty rejectedManifests", () => {
    const parsed = PostLoadFromDirectoryResponseSchema.parse({
      ...VALID_RESPONSE,
      registered: 0,
      items: [],
      rejectedManifests: [],
    });
    expect(parsed.registered).toBe(0);
  });

  it("accepts null packageName on a rejection (manifest with no package.name)", () => {
    const parsed = PostLoadFromDirectoryResponseSchema.parse({
      ...VALID_RESPONSE,
      rejectedManifests: [
        {
          directory: "/tmp/apps/anon",
          packageName: null,
          reason: "no name",
          path: "name",
        },
      ],
    });
    expect(parsed.rejectedManifests[0]?.packageName).toBeNull();
  });

  it("rejects ok:false (route only emits success bodies through this schema)", () => {
    expect(() =>
      PostLoadFromDirectoryResponseSchema.parse({
        ...VALID_RESPONSE,
        ok: false,
      }),
    ).toThrow();
  });

  it("rejects negative registered counts", () => {
    expect(() =>
      PostLoadFromDirectoryResponseSchema.parse({
        ...VALID_RESPONSE,
        registered: -1,
      }),
    ).toThrow();
  });

  it("rejects extra fields on items[i] (strict)", () => {
    expect(() =>
      PostLoadFromDirectoryResponseSchema.parse({
        ...VALID_RESPONSE,
        items: [{ slug: "x", canonicalName: "@x", extra: true }],
      }),
    ).toThrow();
  });
});
