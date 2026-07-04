/**
 * Verifies registerAllProbers() feeds every exported prober into a permissions
 * registry exactly once and in declared order, using a vi.fn registerProber
 * double in place of a real PermissionRegistry.
 */
import { describe, expect, it, vi } from "vitest";

import type { IPermissionsRegistry, Prober } from "./contracts.js";
import { ALL_PROBERS, registerAllProbers } from "./register-probers.js";

describe("registerAllProbers", () => {
  it("registers every exported permission prober exactly once", () => {
    const registerProber = vi.fn();
    const registry = {
      registerProber,
    } as unknown as IPermissionsRegistry;

    registerAllProbers(registry);

    expect(registerProber).toHaveBeenCalledTimes(ALL_PROBERS.length);
    expect(
      registerProber.mock.calls.map((args) => (args[0] as Prober).id),
    ).toEqual(ALL_PROBERS.map((prober) => prober.id));
  });
});
