/**
 * Unit coverage for the host-external view-bundle factory transform
 * (`dynamic-view-host-external.mjs`) shared by the agent bundle route
 * (`views-routes.ts`) and the Playwright UI-smoke stub. Pure string-in/out:
 * wraps sample bundles and evaluates them against a stub `hostImport`, and
 * checks the `parseHostExternalSpecifiers` query parsing — no server, no real
 * bundle build.
 */
import { describe, expect, it } from "vitest";
import {
  HOST_IMPORT_PARAM,
  parseHostExternalSpecifiers,
  wrapBundleAsHostExternalFactory,
} from "./dynamic-view-host-external.mjs";

// Mirror of the shared contract's query-param names (@elizaos/shared). Kept as
// literals here so this dependency-free transform test never pulls the shared
// package graph in; a drift check against the shared constants lives in
// host-external-contract.test.ts.
const HOST_EXTERNAL_RUNTIME_PARAM = "hostExternalRuntime";
const HOST_EXTERNAL_SPECIFIERS_PARAM = "hostExternalSpecifiers";

/**
 * `dynamic-view-host-external.mjs` is the single source of the host-external
 * view-bundle factory transform consumed by BOTH the agent bundle route
 * (`views-routes.ts`) and the Playwright UI-smoke stub. Locking the transform
 * here keeps the two serve paths byte-identical. The transform wraps a served
 * bundle as a `HostExternalBundleFactory` (default export) that resolves its
 * host externals through an injected `hostImport` parameter and returns the
 * bundle's export namespace — no `globalThis` bridge.
 */
describe("wrapBundleAsHostExternalFactory", () => {
  const specifiers = ["@elizaos/ui", "react", "react/jsx-runtime"];

  function evalFactory(source: string) {
    const wrapped = wrapBundleAsHostExternalFactory(source, specifiers);
    // The wrapped module's default export is the factory. Evaluate the module
    // body as a function returning that default so the test can call it with a
    // stub host importer, exactly as the loader does.
    const factory = new Function(
      `${wrapped.replace(/^export default /u, "return ")}`,
    )() as (
      hostImport: (specifier: string) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>;
    return factory;
  }

  it("emits a default-exported async factory taking the host-import param", () => {
    const wrapped = wrapBundleAsHostExternalFactory(
      `export { X as default };`,
      specifiers,
    );
    expect(wrapped).toContain(
      `export default async function ${HOST_IMPORT_PARAM}Factory(${HOST_IMPORT_PARAM})`,
    );
    expect(wrapped).not.toContain("globalThis");
  });

  it("binds a named import via the injected host-import param", async () => {
    const hostImport = async (specifier: string) => {
      if (specifier === "@elizaos/ui")
        return { Button: "BTN", Input: "IN" } as Record<string, unknown>;
      return {};
    };
    const factory = evalFactory(
      `import { Button, Input as TextInput } from "@elizaos/ui";\nexport { Button as ButtonEcho, TextInput as InputEcho };`,
    );
    await expect(factory(hostImport)).resolves.toEqual({
      ButtonEcho: "BTN",
      InputEcho: "IN",
    });
  });

  it("binds a namespace import", async () => {
    const react = { useState: () => 0 } as Record<string, unknown>;
    const factory = evalFactory(
      `import * as React from "react";\nexport { React as ReactNs };`,
    );
    await expect(factory(async () => react)).resolves.toEqual({
      ReactNs: react,
    });
  });

  it("binds a default + named import with a .default fallback", async () => {
    const react = {
      default: "REACT_DEFAULT",
      useState: "USE_STATE",
    } as Record<string, unknown>;
    const factory = evalFactory(
      `import React, { useState } from "react";\nexport { React as R, useState as U };`,
    );
    await expect(factory(async () => react)).resolves.toEqual({
      R: "REACT_DEFAULT",
      U: "USE_STATE",
    });
  });

  it("preserves a side-effect import as a bare host-import call", () => {
    const wrapped = wrapBundleAsHostExternalFactory(
      `import "react/jsx-runtime";\nexport {};`,
      specifiers,
    );
    expect(wrapped).toContain(
      `await ${HOST_IMPORT_PARAM}("react/jsx-runtime");`,
    );
  });

  it("collects the trailing export list into the returned namespace", async () => {
    const factory = evalFactory(
      `const view = "VIEW";\nconst interact = "INTERACT";\nexport { view as default, interact };`,
    );
    await expect(factory(async () => ({}))).resolves.toEqual({
      default: "VIEW",
      interact: "INTERACT",
    });
  });

  it('binds minified no-space imports (import{x}from"y")', async () => {
    // Rollup/esbuild-minified view bundles emit imports with no interior spaces
    // on one line; the transform must bind those too.
    const react = { default: "R", useState: "US" } as Record<string, unknown>;
    const ui = { Button: "BTN" } as Record<string, unknown>;
    const factory = evalFactory(
      `import{Button as b}from"@elizaos/ui";import r,{useState as u}from"react";import"react/jsx-runtime";var v=1;export{b as Btn,r as R,u as U};`,
    );
    await expect(
      factory(async (specifier) =>
        specifier === "react" ? react : specifier === "@elizaos/ui" ? ui : {},
      ),
    ).resolves.toEqual({ Btn: "BTN", R: "R", U: "US" });
  });

  it("leaves non-host-external imports untouched", () => {
    const wrapped = wrapBundleAsHostExternalFactory(
      `import { local } from "./local.js";\nexport { local };`,
      specifiers,
    );
    expect(wrapped).toContain(`import { local } from "./local.js";`);
  });
});

describe("parseHostExternalSpecifiers", () => {
  it(`returns [] unless ${HOST_EXTERNAL_RUNTIME_PARAM}=1`, () => {
    const url = new URL(
      `http://x/bundle.js?${HOST_EXTERNAL_SPECIFIERS_PARAM}=react,@elizaos/ui`,
    );
    expect(parseHostExternalSpecifiers(url)).toEqual([]);
  });

  it("splits and trims the specifier list when enabled", () => {
    const url = new URL(
      `http://x/bundle.js?${HOST_EXTERNAL_RUNTIME_PARAM}=1&${HOST_EXTERNAL_SPECIFIERS_PARAM}=react, @elizaos/ui ,`,
    );
    expect(parseHostExternalSpecifiers(url)).toEqual(["react", "@elizaos/ui"]);
  });
});
