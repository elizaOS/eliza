import { describe, expect, it } from "vitest";
import extend from "./extend";

describe("browser compatibility shims", () => {
  it("honors an explicit shallow merge without retaining nested target keys", () => {
    const nested = { fresh: true };
    const target = { nested: { old: true } };
    const result = extend(false, target, { nested });
    expect(result).toBe(target);
    expect(target.nested).toBe(nested);
    expect(target.nested).toEqual({ fresh: true });
  });

  it("still recursively merges when deep mode is explicitly enabled", () => {
    expect(
      extend(true, { nested: { old: true } }, { nested: { fresh: true } }),
    ).toEqual({ nested: { old: true, fresh: true } });
  });
});
