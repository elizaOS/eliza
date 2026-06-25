import { describe, expect, test } from "vitest";
import {
  type AppImageResolver,
  composeImageResolvers,
  makePrebuiltImageMapResolver,
} from "./app-image-resolver";

const app = (name: string) => ({ id: "a1", name, metadata: {} as Record<string, unknown> });

const EDAD_IMAGE = "ghcr.io/elizaos/example-edad:showcase";
const CUC_IMAGE = "ghcr.io/elizaos/example-clone-ur-crush:showcase";
const MAP = JSON.stringify({
  "eDad Showcase": EDAD_IMAGE,
  "Clone Your Crush Showcase": CUC_IMAGE,
});

describe("makePrebuiltImageMapResolver (#9300 per-app prebuilt image)", () => {
  test("returns undefined when APP_PREBUILT_IMAGES is unset (no behavior change)", () => {
    expect(makePrebuiltImageMapResolver({})).toBeUndefined();
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "" })).toBeUndefined();
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "   " })).toBeUndefined();
  });

  test("returns undefined for malformed JSON (never throws)", () => {
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "{not json" })).toBeUndefined();
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "[]" })).toBeUndefined();
    expect(makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: "{}" })).toBeUndefined();
  });

  test("maps the two distinct showcase apps to their OWN images by name prefix", async () => {
    const resolve = makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: MAP });
    expect(resolve).toBeDefined();
    const r = resolve as AppImageResolver;
    // Timestamped names (what the showcase specs register) still match by prefix.
    expect(await r(app("eDad Showcase 1a2b3c"))).toBe(EDAD_IMAGE);
    expect(await r(app("Clone Your Crush Showcase 9z8y7x"))).toBe(CUC_IMAGE);
  });

  test("returns undefined for an app not in the map (falls through to default)", async () => {
    const r = makePrebuiltImageMapResolver({ APP_PREBUILT_IMAGES: MAP }) as AppImageResolver;
    expect(await r(app("Some Other App"))).toBeUndefined();
  });

  test("longest prefix wins when one name is a prefix of another", async () => {
    const r = makePrebuiltImageMapResolver({
      APP_PREBUILT_IMAGES: JSON.stringify({
        eDad: "ghcr.io/short:1",
        "eDad Showcase": EDAD_IMAGE,
      }),
    }) as AppImageResolver;
    expect(await r(app("eDad Showcase 42"))).toBe(EDAD_IMAGE);
    expect(await r(app("eDad Lite 42"))).toBe("ghcr.io/short:1");
  });
});

describe("composeImageResolvers", () => {
  test("undefined when no resolvers are active", () => {
    expect(composeImageResolvers(undefined, undefined)).toBeUndefined();
  });

  test("first non-undefined image wins; falls through otherwise", async () => {
    const a: AppImageResolver = async (x) => (x.name === "A" ? "img-a" : undefined);
    const b: AppImageResolver = async () => "img-b";
    const composed = composeImageResolvers(a, b) as AppImageResolver;
    expect(await composed(app("A"))).toBe("img-a"); // a wins
    expect(await composed(app("Z"))).toBe("img-b"); // a misses → b
  });
});
