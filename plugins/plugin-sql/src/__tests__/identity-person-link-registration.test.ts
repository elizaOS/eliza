/**
 * Verifies the SQL plugin activates the canonical identity service and its
 * private person-link routes without restoring the retired authority surface
 * or registering any model-callable action.
 */

import { existsSync } from "node:fs";
import { PrincipalService } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import * as sqlPluginExports from "../index";
import { plugin, SqlPrincipalService } from "../index";

describe("identity person-link registration", () => {
  it("registers one canonical service and private routes, with no actions", () => {
    expect(
      plugin.services?.filter((service) => service.serviceType === PrincipalService.serviceType)
    ).toEqual([SqlPrincipalService]);
    expect(plugin.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "identity-person-link-attest",
          type: "POST",
          public: false,
        }),
        expect.objectContaining({
          name: "identity-person-link-verify",
          type: "GET",
          public: false,
        }),
      ])
    );
    expect(plugin.actions).toBeUndefined();
  });

  it("keeps the retired service, export, and implementation files deleted", () => {
    const retiredExport = ["Sql", "Identity", "Resolution", "Service"].join("");
    const retiredBasename = ["sql", "identity", "resolution"].join("-");

    expect(Object.hasOwn(sqlPluginExports, retiredExport)).toBe(false);
    expect(existsSync(new URL(`../services/${retiredBasename}.ts`, import.meta.url))).toBe(false);
    expect(existsSync(new URL(`../services/${retiredBasename}.test.ts`, import.meta.url))).toBe(
      false
    );
  });
});
