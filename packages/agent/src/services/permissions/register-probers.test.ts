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
      registerProber.mock.calls.map(([prober]: [Prober]) => prober.id),
    ).toEqual(ALL_PROBERS.map((prober) => prober.id));
  });
});
