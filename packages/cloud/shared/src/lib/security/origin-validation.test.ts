/**
 * Pins origin allowlisting. This is a security boundary: it decides whether a
 * browser Origin/Referer or a redirect URI is trusted, so the cases that matter
 * are the ones that must be REFUSED — non-http schemes, lookalike domains that
 * merely end in the allowed suffix, the bare apex against a subdomain wildcard,
 * and protocol or port mismatches. Pure module, no harness.
 */

import { describe, expect, test } from "bun:test";
import { isAllowedOrigin, normalizeOrigin } from "./origin-validation";

describe("normalizeOrigin — accepted", () => {
  test("reduces a full URL to its origin", () => {
    expect(normalizeOrigin("https://a.example.com/path?q=1#frag")).toBe("https://a.example.com");
  });

  test("lowercases scheme and host", () => {
    expect(normalizeOrigin("HTTPS://A.EXAMPLE.COM")).toBe("https://a.example.com");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeOrigin("  https://x.com  ")).toBe("https://x.com");
  });

  test("keeps a non-default port and drops a default one", () => {
    expect(normalizeOrigin("https://x.com:8443")).toBe("https://x.com:8443");
    expect(normalizeOrigin("https://x.com:443")).toBe("https://x.com");
    expect(normalizeOrigin("http://x.com:80")).toBe("http://x.com");
  });

  test("drops userinfo rather than carrying it into the origin", () => {
    expect(normalizeOrigin("https://user:pw@x.example.com/")).toBe("https://x.example.com");
  });

  test("accepts plain http", () => {
    expect(normalizeOrigin("http://x.com")).toBe("http://x.com");
  });
});

describe("normalizeOrigin — refused", () => {
  test("refuses every non-http(s) scheme", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "file:///etc/passwd",
      "ftp://x.com",
      "ws://x.com",
      "vbscript:msgbox",
      "blob:https://x.com/abc",
    ]) {
      expect(normalizeOrigin(value)).toBeNull();
    }
  });

  test("refuses values that are not absolute URLs", () => {
    for (const value of ["", "   ", "not a url", "//x.com", "/path", "x.com"]) {
      expect(normalizeOrigin(value)).toBeNull();
    }
  });

  test("never returns a value carrying a path, query, or fragment", () => {
    for (const value of ["https://x.com/a/b", "https://x.com/?q=1", "https://x.com/#f"]) {
      const origin = normalizeOrigin(value);
      expect(origin).not.toBeNull();
      expect((origin as string).split("://")[1]).not.toContain("/");
    }
  });
});

describe("isAllowedOrigin — exact entries", () => {
  test("admits a matching origin", () => {
    expect(isAllowedOrigin(["https://app.example.com"], "https://app.example.com")).toBe(true);
  });

  test("admits a candidate URL carrying a path", () => {
    expect(isAllowedOrigin(["https://app.example.com"], "https://app.example.com/dash?x=1")).toBe(
      true,
    );
  });

  test("normalises an allowlist entry that carries a path", () => {
    expect(isAllowedOrigin(["https://app.example.com/callback"], "https://app.example.com")).toBe(
      true,
    );
  });

  test("refuses a protocol downgrade", () => {
    expect(isAllowedOrigin(["https://app.example.com"], "http://app.example.com")).toBe(false);
  });

  test("refuses a port mismatch", () => {
    expect(isAllowedOrigin(["https://app.example.com"], "https://app.example.com:8443")).toBe(
      false,
    );
  });

  test("refuses a different host", () => {
    for (const candidate of [
      "https://evil.com",
      "https://app.example.com.evil.com",
      "https://appexample.com",
      "https://app.example.co",
    ]) {
      expect(isAllowedOrigin(["https://app.example.com"], candidate)).toBe(false);
    }
  });

  test("skips blank entries without admitting anything", () => {
    expect(isAllowedOrigin(["", "   ", "\t"], "https://app.example.com")).toBe(false);
  });

  test("refuses when the allowlist is empty", () => {
    expect(isAllowedOrigin([], "https://app.example.com")).toBe(false);
  });

  test("admits if any entry matches, regardless of position", () => {
    const list = ["https://a.com", "https://b.com", "https://c.com"];
    for (const candidate of list) {
      expect(isAllowedOrigin(list, candidate)).toBe(true);
    }
  });
});

describe("isAllowedOrigin — refused candidates", () => {
  test("refuses a candidate that is not an http(s) URL", () => {
    for (const candidate of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "not a url",
      "",
      "null",
    ]) {
      expect(isAllowedOrigin(["https://app.example.com"], candidate)).toBe(false);
    }
  });

  test("a non-URL candidate is refused even by the allow-all entry", () => {
    expect(isAllowedOrigin(["*"], "javascript:alert(1)")).toBe(false);
    expect(isAllowedOrigin(["*"], "")).toBe(false);
  });
});

describe("isAllowedOrigin — wildcard entries", () => {
  const LIST = ["https://*.example.com"];

  test("admits a direct subdomain", () => {
    expect(isAllowedOrigin(LIST, "https://app.example.com")).toBe(true);
  });

  test("refuses the bare apex", () => {
    expect(isAllowedOrigin(LIST, "https://example.com")).toBe(false);
  });

  test("refuses a lookalike that only ends similarly", () => {
    for (const candidate of [
      "https://evil-example.com",
      "https://notexample.com",
      "https://example.com.evil.com",
      "https://exampleXcom",
    ]) {
      expect(isAllowedOrigin(LIST, candidate)).toBe(false);
    }
  });

  test("refuses a host that merely CONTAINS the allowed domain", () => {
    // The attacker controls evil.com and registers a subdomain that embeds the
    // allowed one. Only an end-anchored match refuses these.
    for (const candidate of [
      "https://a.example.com.evil.com",
      "https://app.example.com.attacker.net",
      "https://x.example.com.example.org",
    ]) {
      expect(isAllowedOrigin(LIST, candidate)).toBe(false);
    }
  });

  test("refuses a protocol downgrade on a wildcard entry", () => {
    expect(isAllowedOrigin(LIST, "http://app.example.com")).toBe(false);
  });

  test("refuses a non-default port on a wildcard entry", () => {
    expect(isAllowedOrigin(LIST, "https://app.example.com:8443")).toBe(false);
  });

  test("matches case-insensitively", () => {
    expect(isAllowedOrigin(["https://*.EXAMPLE.com"], "https://app.example.com")).toBe(true);
  });

  test("strips a path from a wildcard entry before matching", () => {
    expect(isAllowedOrigin(["https://*.example.com/callback"], "https://app.example.com")).toBe(
      true,
    );
  });

  test("a wildcard entry does not leak into another registrable domain", () => {
    expect(isAllowedOrigin(LIST, "https://app.example.org")).toBe(false);
    expect(isAllowedOrigin(LIST, "https://app.attacker.com")).toBe(false);
  });
});

describe("isAllowedOrigin — allow-all", () => {
  test("the bare * entry admits any valid http(s) origin", () => {
    for (const candidate of [
      "https://anything.com",
      "http://localhost:3000",
      "https://a.b.c.example.com:9999",
    ]) {
      expect(isAllowedOrigin(["*"], candidate)).toBe(true);
    }
  });

  test("a * mixed into a list still admits", () => {
    expect(isAllowedOrigin(["https://a.com", "*"], "https://evil.com")).toBe(true);
  });

  test("a padded * is still treated as allow-all", () => {
    expect(isAllowedOrigin(["  *  "], "https://evil.com")).toBe(true);
  });
});

describe("isAllowedOrigin — regex safety", () => {
  test("regex metacharacters in an entry are matched literally", () => {
    // Without escaping, "." would match any character and admit a lookalike.
    expect(isAllowedOrigin(["https://a.example.com"], "https://aXexample.com")).toBe(false);
    expect(isAllowedOrigin(["https://*.a.example.com"], "https://x.aXexample.com")).toBe(false);
  });

  test("a candidate cannot inject regex syntax through its own host", () => {
    for (const candidate of ["https://.*.example.com", "https://a.example.com%2e"]) {
      expect(isAllowedOrigin(["https://app.example.com"], candidate)).toBe(false);
    }
  });

  test("an entry full of metacharacters cannot become a catch-all", () => {
    expect(isAllowedOrigin(["https://^$+?()[]{}|.com"], "https://evil.com")).toBe(false);
  });
});
