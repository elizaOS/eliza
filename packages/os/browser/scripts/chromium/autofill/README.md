# Android Autofill origin transport

The Chromium component generator applies `../autofill-full-origin.mjs` to the
hash-pinned sources in `../fixtures`. The original downstream patch and license
are retained here as provenance; callers must not apply it a second time.
The generator owns the executable transformation and includes its outputs in the
same integrity report as the native messaging and embedding changes.

`node --test packages/os/browser/scripts/chromium-autofill.test.mjs` compiles the
actual transformed Java with Android test doubles. JDK 21 must be on PATH or in
JAVA_HOME. It checks full origins, ports, per-field origins and missing top-origin
metadata. This is transport evidence, not a complete Chromium build or Autofill
service acceptance. Versioned `ai.elizaresearch.autofill.*` wire keys remain
unchanged for existing consumers; they convey browser-process data, not DOM data.
