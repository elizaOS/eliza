/**
 * Unit coverage for the cascade Actor registry (#9170 M5/M10 grounding seam).
 *
 * `setActor` / `getRegisteredActor` is the single-slot seam through which a
 * grounding Actor (OCR/AX coordinate grounding, or a remote grounder) is wired
 * into the cascade loop. Its lifecycle was untested.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "../actor/actor.js";
import { getRegisteredActor, setActor } from "../actor/cascade.js";

const fakeActor = (name: string): Actor => ({
  name,
  ground: async () => {
    throw new Error("ground() is not exercised by the registry test");
  },
});

afterEach(() => setActor(null));

describe("cascade Actor registry", () => {
  it("is empty until an actor is registered", () => {
    setActor(null);
    expect(getRegisteredActor()).toBeNull();
  });

  it("returns the registered actor; last call wins; null clears", () => {
    setActor(fakeActor("primary"));
    expect(getRegisteredActor()?.name).toBe("primary");
    setActor(fakeActor("secondary"));
    expect(getRegisteredActor()?.name).toBe("secondary");
    setActor(null);
    expect(getRegisteredActor()).toBeNull();
  });
});
