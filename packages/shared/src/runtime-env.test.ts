/**
 * Unit coverage for the runtime-env host security helpers (`runtime-env.ts`):
 * loopback/wildcard bind-host classification, URL/bracketed host stripping, and
 * `resolveApiSecurityConfig` — proving malformed `127.*` binds are never promoted to
 * loopback and that the origin/host allow-lists are trimmed into arrays.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "./config/boot-config";
import {
  createSelfApiRequestHeaders,
  firstWinningEnvString,
  isAndroidMobile,
  isDevApiWatchEnabled,
  isIosMobile,
  isLoopbackBindHost,
  isMobilePlatform,
  isWildcardBindHost,
  resolveApiExposePort,
  resolveApiSecurityConfig,
  resolveApiToken,
  resolveDesktopApiPortPreference,
  resolvePlatform,
  resolveRuntimePorts,
  resolveSelfApiCredential,
  stripOptionalHostPort,
} from "./runtime-env";

describe("runtime env host security helpers", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.255",
    "localhost",
    "::1",
    "[::1]:31337",
    "http://127.0.0.1:31337",
    "::ffff:127.0.0.1",
  ])("treats valid loopback bind hosts as local: %s", (host) => {
    expect(isLoopbackBindHost(host)).toBe(true);
  });

  it.each([
    "127.999.999.999",
    "127.0.0.256",
    "127.foo",
    "127.0.0.1.evil.example",
    "192.168.1.1",
    "example.com",
  ])("does not treat malformed or remote hosts as loopback: %s", (host) => {
    expect(isLoopbackBindHost(host)).toBe(false);
  });

  it("parses URL and bracketed host forms before classifying bind hosts", () => {
    expect(stripOptionalHostPort("https://LOCALHOST:31337/path")).toBe(
      "localhost",
    );
    expect(stripOptionalHostPort("[::1]:31337")).toBe("::1");
    expect(isWildcardBindHost("0.0.0.0:31337")).toBe(true);
  });

  it("resolves API security config without promoting malformed 127.* binds to loopback", () => {
    const config = resolveApiSecurityConfig({
      ELIZA_API_BIND: "127.999.999.999",
      ELIZA_ALLOWED_ORIGINS: " https://app.example, http://localhost:2138 ",
      ELIZA_ALLOWED_HOSTS: " app.example,localhost ",
      ELIZA_ALLOW_NULL_ORIGIN: "true",
      ELIZA_API_TOKEN: "token",
    });

    expect(config).toMatchObject({
      bindHost: "127.999.999.999",
      token: "token",
      allowNullOrigin: true,
      isLoopbackBind: false,
      isWildcardBind: false,
    });
    expect(config.allowedOrigins).toEqual([
      "https://app.example",
      "http://localhost:2138",
    ]);
    expect(config.allowedHosts).toEqual(["app.example", "localhost"]);
  });
});

describe("self API request authentication", () => {
  it("normalizes raw and prefixed tokens to one Bearer header", () => {
    expect(
      createSelfApiRequestHeaders({ ELIZA_API_TOKEN: " canonical-token " }),
    ).toEqual({ Authorization: "Bearer canonical-token" });
    expect(
      createSelfApiRequestHeaders({
        ELIZA_API_TOKEN: " bearer    already-prefixed ",
      }),
    ).toEqual({ Authorization: "Bearer already-prefixed" });
  });

  it("prefers the canonical token and supports the legacy compatibility key", () => {
    expect(
      createSelfApiRequestHeaders({
        ELIZA_API_TOKEN: "canonical-token",
        ELIZA_API_AUTH_TOKEN: "legacy-token",
      }),
    ).toEqual({ Authorization: "Bearer canonical-token" });
    expect(
      createSelfApiRequestHeaders({
        ELIZA_API_AUTH_TOKEN: " legacy-token ",
      }),
    ).toEqual({ Authorization: "Bearer legacy-token" });
  });

  it("omits Authorization when neither configured token is present", () => {
    expect(createSelfApiRequestHeaders({})).toEqual({});
    expect(
      createSelfApiRequestHeaders({
        ELIZA_API_TOKEN: "   ",
        ELIZA_API_AUTH_TOKEN: "   ",
      }),
    ).toEqual({});
  });

  // The defect this guards: the caller normalized the credential while the
  // server compared its own un-normalized configured value, so a
  // `Bearer `-prefixed or legacy-only configuration 401'd every protected
  // caller. The server expects exactly `resolveSelfApiCredential(env)`, so
  // whatever the caller puts after `Bearer ` must equal it for every shape.
  it("sends exactly the credential the server resolves, for every configured shape", () => {
    const configurations: Array<Record<string, string>> = [
      { ELIZA_API_TOKEN: "canonical-token" },
      { ELIZA_API_TOKEN: " canonical-token " },
      { ELIZA_API_TOKEN: "Bearer canonical-token" },
      { ELIZA_API_TOKEN: " bearer    canonical-token " },
      { ELIZA_API_AUTH_TOKEN: "legacy-token" },
      { ELIZA_API_AUTH_TOKEN: " Bearer legacy-token " },
      {
        ELIZA_API_TOKEN: "Bearer canonical-token",
        ELIZA_API_AUTH_TOKEN: "legacy-token",
      },
    ];

    for (const env of configurations) {
      const expected = resolveSelfApiCredential(env);
      expect(expected).toBeTruthy();
      const header = createSelfApiRequestHeaders(env).Authorization;
      expect(header, JSON.stringify(env)).toBe(`Bearer ${expected}`);
      // Mirror the server's own extraction of the request header.
      expect(header?.replace(/^Bearer /, ""), JSON.stringify(env)).toBe(
        expected,
      );
    }
  });

  // Regression: `firstNonEmpty` returns null for an unset key, and the Bearer
  // strip at `resolveApiSecurityConfig` once only handled undefined — every
  // tokenless deployment crashed with a TypeError before any request ran.
  it("resolves a null server token without a configured value, and strips a configured Bearer prefix", () => {
    expect(resolveApiToken({})).toBeNull();
    expect(resolveApiToken({ ELIZA_API_TOKEN: "   " })).toBeNull();
    expect(resolveApiToken({ ELIZA_API_TOKEN: "Bearer server-token" })).toBe(
      "server-token",
    );
    expect(resolveApiSecurityConfig({}).token).toBeNull();
  });

  it("resolves no credential when neither key carries a value", () => {
    expect(resolveSelfApiCredential({})).toBeNull();
    expect(resolveSelfApiCredential({ ELIZA_API_TOKEN: "   " })).toBeNull();
    expect(
      resolveSelfApiCredential({
        ELIZA_API_TOKEN: "   ",
        ELIZA_API_AUTH_TOKEN: "  ",
      }),
    ).toBeNull();
  });

  // A value of exactly "Bearer" survives stripping, because the prefix rule
  // requires whitespace after it. That is a misconfiguration either way; what
  // must hold is that BOTH sides read it the same, so it authenticates or
  // fails as a unit instead of becoming a silent 401 on one side only.
  it("keeps a degenerate 'Bearer' value consistent across the boundary", () => {
    const env = { ELIZA_API_TOKEN: "Bearer " };
    expect(resolveSelfApiCredential(env)).toBe("Bearer");
    expect(createSelfApiRequestHeaders(env)).toEqual({
      Authorization: "Bearer Bearer",
    });
  });
});

describe("dev API watch detection", () => {
  it("detects node/bun --watch from exec argv", () => {
    expect(isDevApiWatchEnabled({}, ["--watch"])).toBe(true);
  });

  it("detects desktop API watch and dev-ui source watcher env flags", () => {
    expect(isDevApiWatchEnabled({ ELIZA_DESKTOP_API_WATCH: "1" }, [])).toBe(
      true,
    );
    expect(isDevApiWatchEnabled({ ELIZA_DEV_SOURCE_WATCH: "1" }, [])).toBe(
      true,
    );
  });

  it("does not treat ELIZA_DEV_NO_WATCH=0 as an enabled watcher", () => {
    expect(isDevApiWatchEnabled({ ELIZA_DEV_NO_WATCH: "0" }, [])).toBe(false);
  });
});

describe("runtime env alias resolution", () => {
  const savedConfig = getBootConfig();
  const aliases: Array<readonly [string, string]> = [
    ["ACME_PORT", "ELIZA_PORT"],
    ["ACME_UI_PORT", "ELIZA_UI_PORT"],
    ["ACME_API_PORT", "ELIZA_API_PORT"],
    ["ACME_API_EXPOSE_PORT", "ELIZA_API_EXPOSE_PORT"],
    ["ACME_API_BIND", "ELIZA_API_BIND"],
    ["ACME_API_TOKEN", "ELIZA_API_TOKEN"],
    ["ACME_ALLOWED_ORIGINS", "ELIZA_ALLOWED_ORIGINS"],
    ["ACME_ALLOWED_HOSTS", "ELIZA_ALLOWED_HOSTS"],
    ["ACME_ALLOW_NULL_ORIGIN", "ELIZA_ALLOW_NULL_ORIGIN"],
    ["ACME_DISABLE_AUTO_API_TOKEN", "ELIZA_DISABLE_AUTO_API_TOKEN"],
    ["ACME_PLATFORM", "ELIZA_PLATFORM"],
  ];

  beforeEach(() => {
    setBootConfig({ ...savedConfig, envAliases: aliases });
  });

  afterEach(() => {
    setBootConfig(savedConfig);
  });

  it("resolves ports from a non-ELIZA brand prefix without materializing mirror keys", () => {
    const env = {
      ACME_PORT: "4666",
      ACME_UI_PORT: "4777",
      ACME_API_PORT: "4555",
      ACME_API_EXPOSE_PORT: "true",
    };

    expect(resolveRuntimePorts(env)).toEqual({
      serverOnlyPort: 4666,
      desktopApiPort: 4555,
      desktopUiPort: 4777,
    });
    expect(resolveDesktopApiPortPreference(env)).toMatchObject({
      port: 4555,
      winningKey: "ACME_API_PORT",
    });
    expect(resolveApiExposePort(env)).toBe(true);
    expect(env).not.toHaveProperty("ELIZA_PORT");
    expect(env).not.toHaveProperty("ELIZA_UI_PORT");
    expect(env).not.toHaveProperty("ELIZA_API_PORT");
    expect(env).not.toHaveProperty("ELIZA_API_EXPOSE_PORT");
  });

  it("resolves API security config from branded aliases without mutating the env record", () => {
    const env = {
      ACME_API_BIND: "0.0.0.0",
      ACME_API_TOKEN: "branded-token",
      ACME_ALLOWED_ORIGINS: " https://acme.example, http://localhost:2138 ",
      ACME_ALLOWED_HOSTS: " acme.example,localhost ",
      ACME_ALLOW_NULL_ORIGIN: "true",
      ACME_DISABLE_AUTO_API_TOKEN: "1",
    };
    const before = { ...env };

    expect(resolveApiSecurityConfig(env)).toMatchObject({
      bindHost: "0.0.0.0",
      token: "branded-token",
      allowedOrigins: ["https://acme.example", "http://localhost:2138"],
      allowedHosts: ["acme.example", "localhost"],
      allowNullOrigin: true,
      disableAutoApiToken: true,
      isLoopbackBind: false,
      isWildcardBind: true,
    });
    expect(env).toEqual(before);
    expect(env).not.toHaveProperty("ELIZA_API_TOKEN");
    expect(env).not.toHaveProperty("ELIZA_ALLOWED_ORIGINS");
    expect(firstWinningEnvString(env, ["ELIZA_API_TOKEN"])).toEqual({
      key: "ACME_API_TOKEN",
      value: "branded-token",
    });
    expect(createSelfApiRequestHeaders(env)).toEqual({
      Authorization: "Bearer branded-token",
    });
  });

  it("keeps explicit ELIZA values ahead of brand aliases", () => {
    const config = resolveApiSecurityConfig({
      ACME_API_TOKEN: "branded-token",
      ELIZA_API_TOKEN: "canonical-token",
    });

    expect(config.token).toBe("canonical-token");
  });

  it("resolves API expose-port from a branded alias", () => {
    const env = {
      ACME_API_EXPOSE_PORT: "true",
    };

    expect(resolveApiExposePort(env)).toBe(true);
    expect(env).not.toHaveProperty("ELIZA_API_EXPOSE_PORT");
  });

  it("resolves mobile platform checks from a branded alias", () => {
    const env = {
      ACME_PLATFORM: "android",
    };

    expect(isMobilePlatform(env)).toBe(true);
    expect(isAndroidMobile(env)).toBe(true);
    expect(isIosMobile(env)).toBe(false);
    expect(resolvePlatform(env)).toBe("android");
    expect(env).not.toHaveProperty("ELIZA_PLATFORM");
  });

  it("resolves iOS platform checks from a branded alias without materializing the mirror", () => {
    const env = {
      // upper-case + padding proves the resolver trims + lowercases the value
      ACME_PLATFORM: "  IOS  ",
    };

    expect(isIosMobile(env)).toBe(true);
    expect(isMobilePlatform(env)).toBe(true);
    expect(isAndroidMobile(env)).toBe(false);
    expect(resolvePlatform(env)).toBe("ios");
    expect(env).not.toHaveProperty("ELIZA_PLATFORM");
  });

  it("resolvePlatform returns undefined when neither the canonical key nor a branded alias is set", () => {
    expect(resolvePlatform({})).toBeUndefined();
    expect(isMobilePlatform({})).toBe(false);
    expect(isAndroidMobile({})).toBe(false);
    expect(isIosMobile({})).toBe(false);
  });

  it("keeps an explicit ELIZA_PLATFORM ahead of the branded alias", () => {
    const env = {
      ACME_PLATFORM: "android",
      ELIZA_PLATFORM: "ios",
    };

    // canonical key wins; the branded alias never suppresses a present
    // ELIZA_ value (matches the direct-key precedence contract used for
    // ports / API security above).
    expect(resolvePlatform(env)).toBe("ios");
    expect(isIosMobile(env)).toBe(true);
    expect(isAndroidMobile(env)).toBe(false);
  });

  it("a blank ELIZA_PLATFORM does not shadow a present branded alias", () => {
    const env = {
      ELIZA_PLATFORM: "   ",
      ACME_PLATFORM: "android",
    };

    // empty-is-unset: the blank canonical value must fall through to the
    // branded alias rather than resolving as "no platform".
    expect(resolvePlatform(env)).toBe("android");
    expect(isAndroidMobile(env)).toBe(true);
  });
});
