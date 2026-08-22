/**
 * Verifies the SQL plugin activates the canonical identity service and its
 * private person-link routes without registering any model-callable action.
 */
import { IdentityResolutionService } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { plugin } from "../index";

describe("identity person-link registration", () => {
  it("registers one canonical service and private routes, with no actions", () => {
    expect(
      plugin.services?.some(
        (service) => service.serviceType === IdentityResolutionService.serviceType
      )
    ).toBe(true);
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
});
