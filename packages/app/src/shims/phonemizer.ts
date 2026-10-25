/**
 * Browser replacement for the npm `phonemizer` package (aliased in vite.config.ts).
 *
 * `phonemizer` ships only a Node build: an Emscripten eSpeak-NG module whose
 * top-level init gunzips embedded voice data with
 * `for await (… of blob.stream().pipeThrough(new DecompressionStream("gzip")))`
 * and relies on process/Buffer/`node:` requires. Bundled into the WKWebView
 * renderer, that init throws "undefined is not a function" at module-eval —
 * older WKWebView lacks `ReadableStream` async iteration — as an *unhandled*
 * rejection (the module runs the gunzip as a fire-and-forget IIFE, so the
 * Kokoro adapter's try/catch around `import("phonemizer")` never catches it).
 *
 * The renderer never needs real eSpeak phonemization: the Kokoro TTS adapter
 * (`plugin-local-inference/.../kokoro/phonemizer.ts`) falls back to its bundled
 * `FallbackG2PPhonemizer` when this module exposes no `phonemize`. So alias the
 * package to this empty replacement for the browser build, keeping the 1.3 MB Node
 * blob out of the bundle entirely. The Node agent imports the real package
 * directly (it does not go through Vite), so server-side Kokoro TTS is
 * unaffected.
 *
 * Intentionally exports no `phonemize`: NpmPhonemizePhonemizer.tryLoad() sees no
 * function and returns null, so the caller uses FallbackG2PPhonemizer.
 */

export {};
