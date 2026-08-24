import { describe, expect, it, vi } from "vitest";
import { createLocalizedExamplesResolver } from "./localized-examples-resolver";

function makeRegistry(pairs: Record<string, Record<string, unknown>>) {
  return {
    getPair: vi.fn(
      (key: string, locale: string) => pairs[key]?.[locale] ?? null,
    ),
  };
}

describe("createLocalizedExamplesResolver", () => {
  it("returns a no-op resolver for unsupported locales", () => {
    const registry = makeRegistry({});
    const resolver = createLocalizedExamplesResolver({
      registry,
      locale: "de",
    });
    expect(resolver({ actionName: "send_email", exampleIndex: 0 })).toBeNull();
    // Unsupported locale must short-circuit before touching the registry.
    expect(registry.getPair).not.toHaveBeenCalled();
  });

  it("resolves pairs with the <action>.example.<index> key shape", () => {
    const pair = { user: "Hola", agent: "¿Qué necesitas?" };
    const registry = makeRegistry({ "send_email.example.2": { es: pair } });
    const resolver = createLocalizedExamplesResolver({
      registry,
      locale: "es",
    });
    expect(resolver({ actionName: "send_email", exampleIndex: 2 })).toBe(pair);
    expect(registry.getPair).toHaveBeenCalledWith("send_email.example.2", "es");
  });

  it("returns null when the registry has no pair for the key", () => {
    const registry = makeRegistry({});
    const resolver = createLocalizedExamplesResolver({
      registry,
      locale: "fr",
    });
    expect(resolver({ actionName: "send_email", exampleIndex: 0 })).toBeNull();
    expect(registry.getPair).toHaveBeenCalledWith("send_email.example.0", "fr");
  });

  it("honors every supported registry locale", () => {
    for (const locale of ["en", "es", "fr", "ja"]) {
      const registry = makeRegistry({});
      const resolver = createLocalizedExamplesResolver({
        registry,
        locale,
      });
      expect(
        resolver({ actionName: "some_action", exampleIndex: 1 }),
      ).toBeNull();
      expect(registry.getPair).toHaveBeenCalledTimes(1);
    }
  });
});
