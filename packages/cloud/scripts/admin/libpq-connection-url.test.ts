/** Exercises PostgreSQL URL compatibility without weakening connection identity or TLS options. */

import { describe, expect, test } from "bun:test";
import { toLibpqConnectionUrl } from "./libpq-connection-url";

describe("libpq connection URL", () => {
  test("removes only the provider client compatibility hint", () => {
    expect(
      toLibpqConnectionUrl(
        "postgresql://operator:p%40ss@db.example.test:5432/eliza?sslmode=require&uselibpqcompat=true&channel_binding=require",
      ),
    ).toBe(
      "postgresql://operator:p%40ss@db.example.test:5432/eliza?sslmode=require&channel_binding=require",
    );
  });

  test("preserves a URL that already contains only libpq options", () => {
    const value =
      "postgres://operator:secret@db.example.test/eliza?sslmode=verify-full";
    expect(toLibpqConnectionUrl(value)).toBe(value);
  });

  test.each(["", "https://db.example.test/eliza"])(
    "rejects a non-PostgreSQL connection URL",
    (value) => {
      expect(() => toLibpqConnectionUrl(value)).toThrow();
    },
  );

  test.each([
    "?uselibpqcompat=false",
    "?uselibpqcompat=",
    "?uselibpqcompat=true&uselibpqcompat=true",
    "?UseLibpqCompat=true",
  ])("rejects an ambiguous compatibility hint: %s", (query) => {
    expect(() =>
      toLibpqConnectionUrl(
        `postgresql://operator:secret@db.example.test/eliza${query}`,
      ),
    ).toThrow("invalid libpq compatibility hint");
  });
});
