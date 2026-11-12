/**
 * A cold voice request evaluates the whole static import graph of its route
 * before auth. The ElevenLabs SDK is about 8 MB of source that only the
 * ElevenLabs lane uses, so the STT and TTS routes reach it only through the
 * dynamic import inside that lane.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const SDK = "/@elevenlabs/elevenlabs-js/";

test.each(["stt", "tts"])(
  "the %s route loads the ElevenLabs SDK only in its ElevenLabs lane",
  async (route) => {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, `../v1/voice/${route}/route.ts`)],
      target: "node",
      conditions: ["eliza-source"],
      // Native Node-only modules are not part of the Worker bundle.
      external: ["cloudflare:*", "cpu-features", "ssh2"],
      metafile: true,
      throw: false,
    });
    if (!build.success || !build.metafile)
      throw new AggregateError(build.logs, `${route} route build failed`);
    const { inputs } = build.metafile;
    const entry = Object.keys(inputs).find((path) =>
      path.endsWith(`v1/voice/${route}/route.ts`),
    );
    if (!entry) throw new Error(`${route} route is not in the build`);
    const sdkReachedBy = (kinds: "static" | "static-and-dynamic") => {
      const reached = new Set([entry]);
      for (const path of reached)
        for (const imported of inputs[path]?.imports ?? [])
          if (
            !imported.external &&
            (kinds === "static-and-dynamic" ||
              imported.kind !== "dynamic-import")
          )
            reached.add(imported.path);
      return [...reached].filter((path) => path.includes(SDK));
    };

    expect(sdkReachedBy("static")).toEqual([]);
    expect(sdkReachedBy("static-and-dynamic").length).toBeGreaterThan(0);
  },
);
