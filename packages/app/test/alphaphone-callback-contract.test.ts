/**
 * Cross-repo contract for the Alpha Phone in-app sign-in callback.
 *
 * test/fixtures/alphaphone-native-signin-callback.contract.json is committed,
 * byte for byte, in elizaOS/eliza and AlphaCompute/alphaphone. Alpha's native
 * callback parser runs the same `cases`; this suite pins the reference
 * classifier to them and drives the real fallback page (served by the Pages
 * middleware, plus its pinned script) through every `fallbackCases` vector, so
 * the page can never hand the app a shape the app would not accept, and never
 * a code. Steward's half (success in the fragment, error recovery links in the
 * query) is pinned by packages/auth native-app-link-oauth.integration.test.ts
 * against the same file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_CALLBACK_SCRUB_SCRIPT,
  NATIVE_SIGN_IN_CALLBACK_PATH,
  NATIVE_SIGN_IN_PACKAGE,
  onRequest,
} from "../functions/_middleware";

type Env = "production" | "staging";
type Outcome =
  | { kind: "success"; code: string; state: string }
  | { kind: "error"; error: string; state: string }
  | { kind: "empty" }
  | { kind: "reject" };

interface ContractFixture {
  contract: string;
  version: number;
  hosts: Record<Env, string>;
  path: string;
  package: string;
  allowedKeys: string[];
  codePattern: string;
  statePattern: string;
  fallbackError: string;
  errorAllowlist: string[];
  stewardCodesWithoutReturn: string[];
  authorize: {
    path: string;
    requiredParams: Record<string, string>;
    redirectUri: Record<Env, string>;
  };
  cases: { name: string; env: Env; url: string; expect: Outcome }[];
  fallbackCases: {
    name: string;
    env: Env;
    pageUrl: string;
    handOff: string;
    expect: Outcome;
  }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "fixtures",
      "alphaphone-native-signin-callback.contract.json",
    ),
    "utf8",
  ),
) as ContractFixture;

const codePattern = new RegExp(fixture.codePattern);
const statePattern = new RegExp(fixture.statePattern);

function pairs(component: string): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const pair of component.split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0 || pair.indexOf("=", separator + 1) !== -1) return null;
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!fixture.allowedKeys.includes(key) || value === "") return null;
    if (values.has(key)) return null;
    values.set(key, value);
  }
  return values;
}

/** Reference classifier: the fixture's `rules`, applied to the raw URL text. */
function classify(url: string, env: Env): Outcome {
  const reject: Outcome = { kind: "reject" };
  const base = `https://${fixture.hosts[env]}${fixture.path}`;
  if (!url.startsWith(base)) return reject;
  const rest = url.slice(base.length);
  let query = "";
  let fragment = "";
  if (rest.startsWith("?")) {
    const hash = rest.indexOf("#");
    query = hash === -1 ? rest.slice(1) : rest.slice(1, hash);
    fragment = hash === -1 ? "" : rest.slice(hash + 1);
  } else if (rest.startsWith("#")) {
    fragment = rest.slice(1);
  } else if (rest !== "") {
    return reject;
  }
  if (query === "" && fragment === "") return { kind: "empty" };
  if (query !== "" && fragment !== "") return reject;
  const values = pairs(query || fragment);
  if (values?.size !== 2) return reject;
  const state = values.get("state");
  if (!state || !statePattern.test(state)) return reject;
  const code = values.get("code");
  if (code !== undefined) {
    if (fragment === "" || !codePattern.test(code)) return reject;
    return { kind: "success", code, state };
  }
  const error = values.get("error");
  if (error === undefined || !fixture.errorAllowlist.includes(error)) {
    return reject;
  }
  return { kind: "error", error, state };
}

/** intent://H/P?Q#Intent;scheme=https;package=PKG;end → https://H/P?Q */
function intentToHttps(intent: string): string {
  const suffix = `#Intent;scheme=https;package=${fixture.package};end`;
  expect(intent.startsWith("intent://")).toBe(true);
  expect(intent.endsWith(suffix)).toBe(true);
  return `https://${intent.slice("intent://".length, -suffix.length)}`;
}

const unescapeHref = (value: string) =>
  value
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");

/** Serves the fallback for `pageUrl`, then runs its pinned script as a browser would. */
async function fallbackHandOff(pageUrl: string) {
  const page = new URL(pageUrl);
  const response = await onRequest({
    request: new Request(pageUrl),
    env: {},
    next: async () => new Response("spa"),
  } as unknown as Parameters<typeof onRequest>[0]);
  expect(response.status).toBe(200);
  const html = await response.text();
  const match = html.match(/<a id="open" href="([^"]*)">/);
  expect(match).not.toBeNull();
  const anchor = { href: unescapeHref(match?.[1] ?? "") };
  const serverHref = anchor.href;
  new Function("document", "location", "history", NATIVE_CALLBACK_SCRUB_SCRIPT)(
    { getElementById: (id: string) => (id === "open" ? anchor : null) },
    {
      hash: page.hash,
      host: page.host,
      pathname: page.pathname,
      search: page.search,
    },
    { replaceState: () => undefined },
  );
  return { html, serverHref, href: anchor.href };
}

describe("Alpha Phone sign-in callback contract (shared fixture)", () => {
  it("describes the callback this repository serves", () => {
    expect(fixture.contract).toBe("alphaphone-native-signin-callback");
    expect(fixture.version).toBe(1);
    expect(fixture.path).toBe(NATIVE_SIGN_IN_CALLBACK_PATH);
    expect(fixture.package).toBe(NATIVE_SIGN_IN_PACKAGE);
    expect(fixture.hosts).toEqual({
      production: "eliza.app",
      staging: "staging.eliza.app",
    });
    expect(fixture.errorAllowlist).toContain(fixture.fallbackError);
    expect(fixture.authorize.requiredParams.prompt).toBe("select_account");
    for (const env of ["production", "staging"] as const) {
      expect(fixture.authorize.redirectUri[env]).toBe(
        `https://${fixture.hosts[env]}${fixture.path}`,
      );
    }
    // Every outcome kind is covered.
    const kinds = new Set(fixture.cases.map((entry) => entry.expect.kind));
    expect([...kinds].sort()).toEqual(["empty", "error", "reject", "success"]);
  });

  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      expect(classify(entry.url, entry.env)).toEqual(entry.expect);
    },
  );

  it.each(fixture.fallbackCases.map((entry) => [entry.name, entry] as const))(
    "fallback page: %s",
    async (_name, entry) => {
      const { html, serverHref, href } = await fallbackHandOff(entry.pageUrl);
      // Server-rendered: parameterless, whatever the request carried.
      expect(intentToHttps(serverHref)).toBe(
        `https://${fixture.hosts[entry.env]}${fixture.path}`,
      );
      const handOff = intentToHttps(href);
      expect(handOff).toBe(entry.handOff);
      expect(classify(handOff, entry.env)).toEqual(entry.expect);
      // The fallback never carries or renders a code.
      expect(handOff).not.toMatch(/[?#&]code=/);
      const code = new URLSearchParams(
        new URL(entry.pageUrl).hash.slice(1) || new URL(entry.pageUrl).search,
      ).get("code");
      if (code) {
        expect(html).not.toContain(code);
        expect(href).not.toContain(code);
      }
    },
  );

  it("the fallback hand-off is never a success return for any accepted success vector", async () => {
    for (const entry of fixture.cases) {
      if (entry.expect.kind !== "success") continue;
      const { href } = await fallbackHandOff(entry.url);
      const outcome = classify(intentToHttps(href), entry.env);
      expect(outcome).toEqual({
        kind: "error",
        error: fixture.fallbackError,
        state: entry.expect.state,
      });
    }
  });
});
