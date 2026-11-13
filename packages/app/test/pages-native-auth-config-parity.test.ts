/** Renderer callback acceptance must imply the deployed Pages selector can serve it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeploymentFileError,
  validateDeployment,
} from "../../cloud/deploy/src/schema";
import {
  type NativeAuthCallback,
  selectNativeAuthCallback,
} from "../functions/_middleware";

type Table = Record<string, unknown>;
const APP = "https://cloud.example.org";
const baseBrowser: NonNullable<NativeAuthCallback["browserSignIn"]> = {
  startPath: "/example/auth/browser-start",
  returnPath: "/auth/return",
  storageKey: "example-product:browser-sign-in",
  apiOrigin: "https://api.example.org",
  tenant: "example-product",
};
const base: NativeAuthCallback = {
  redirectUri: `${APP}/example/auth/callback`,
  androidPackage: "org.example.product",
  appName: "Example Product",
  browserSignIn: baseBrowser,
};
const simple = (redirectUri: string): NativeAuthCallback => ({
  redirectUri,
  androidPackage: base.androidPackage,
  appName: base.appName,
});
const browser = (
  fields: Partial<NonNullable<NativeAuthCallback["browserSignIn"]>>,
  redirectUri = base.redirectUri,
): NativeAuthCallback => ({
  ...base,
  redirectUri,
  browserSignIn: { ...baseBrowser, ...fields },
});
function deployment(callbacks: NativeAuthCallback[], apiOrigin?: string) {
  const input = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../cloud/deploy/examples/product.json"),
      "utf8",
    ),
  ) as Table;
  const env = (input.environments as Table).production as Table;
  ((env.components as Table).web as Table).nativeAuthCallbacks = callbacks;
  if (apiOrigin) (env.origins as Table).api = apiOrigin;
  return input;
}

describe("renderer and Pages native callback contract", () => {
  const invalid: {
    name: string;
    callbacks: NativeAuthCallback[];
    apiOrigin?: string;
  }[] = [
    ...[
      "/.well-known/openid-configuration",
      "/.well-known/oidc/jwks.json",
      "/.well-known/assetlinks.json",
    ].flatMap((path) => [
      { name: `protocol callback ${path}`, callbacks: [simple(APP + path)] },
      {
        name: `protocol browser start ${path}`,
        callbacks: [browser({ startPath: path })],
      },
      {
        name: `protocol browser return ${path}`,
        callbacks: [browser({ returnPath: path })],
      },
    ]),
    {
      name: "browser start path normalization",
      callbacks: [browser({ startPath: "/example/../start" })],
    },
    {
      name: "browser return path normalization",
      callbacks: [browser({ returnPath: "/example/./return" })],
    },
    {
      name: "same-origin browser storage key",
      callbacks: [
        base,
        browser(
          { startPath: "/second/auth/browser-start" },
          `${APP}/second/auth/callback`,
        ),
      ],
    },
    {
      name: "callback shadows earlier derived billing return",
      callbacks: [base, simple(`${APP}/example/billing/return`)],
    },
    {
      name: "derived billing return shadows earlier callback",
      callbacks: [simple(`${APP}/example/billing/return`), base],
    },
    {
      name: "browser start shadows own derived billing return",
      callbacks: [browser({ startPath: "/example/billing/return" })],
    },
    {
      name: "HTTP loopback browser API",
      callbacks: [browser({ apiOrigin: "http://127.0.0.1:8787" })],
      apiOrigin: "http://127.0.0.1:8787",
    },
  ];
  it.each(invalid)(
    "rejects $name in both validators",
    ({ callbacks, apiOrigin }) => {
      expect(() =>
        selectNativeAuthCallback(
          JSON.stringify(callbacks),
          new URL(base.redirectUri),
        ),
      ).toThrow();
      expect(() =>
        validateDeployment(deployment(callbacks, apiOrigin)),
      ).toThrow(DeploymentFileError);
    },
  );

  const valid: { name: string; callbacks: NativeAuthCallback[] }[] = [
    { name: "configured browser callback", callbacks: [base] },
    {
      name: "callback without a derived billing route",
      callbacks: [simple(`${APP}/notes/return`)],
    },
    { name: "exact assets path", callbacks: [simple(`${APP}/assets`)] },
    {
      name: "browser storage keys scoped to separate origins",
      callbacks: [
        base,
        browser({}, "https://example.org/example/auth/callback"),
      ],
    },
  ];
  it.each(valid)("accepts $name in both validators", ({ callbacks }) => {
    const checked = validateDeployment(deployment(callbacks));
    const renderedCallbacks =
      checked.environments.production?.components?.web?.nativeAuthCallbacks;
    expect(renderedCallbacks).toEqual(callbacks);
    for (const callback of callbacks) {
      expect(
        selectNativeAuthCallback(
          JSON.stringify(renderedCallbacks),
          new URL(callback.redirectUri),
        ),
      ).toEqual(callback);
    }
  });
});
