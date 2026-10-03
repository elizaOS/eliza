# sqlite-vec iOS build

The Bun host owns this opt-in cross-build tool for the SQLite vector extension.
`VERSION` pins the upstream revision. Generated sources, archives and frameworks
stay under this directory and are not package source.

```bash
ELIZA_SQLITE_VEC_BUILD_IOS=1 bun run --cwd plugins/plugin-native-bun-runtime build:sqlite-vec
bun run --cwd plugins/plugin-native-bun-runtime build:sqlite-vec:device
bun run --cwd plugins/plugin-native-bun-runtime build:sqlite-vec:simulator
bun run --cwd plugins/plugin-native-bun-runtime clean:sqlite-vec
```

The combined build produces `dist/SqliteVec.xcframework` with device and
Apple-silicon simulator slices. It requires macOS and full Xcode.
`SQLITE_VEC_REPO` overrides the source repository; `ELIZA_IOS_MIN_VERSION`
sets the deployment target (default iOS 16.0). The compiler rejects targets
that lack APIs used by the pinned extension. The builder compiles the upstream
C source directly with Xcode’s SDK and creates static archives; it does not
require an upstream CMake project.

The host's existing SQLite bridge reports vector support unavailable when the
extension is not linked. This build command does not change that host policy or
automatically add the framework to an app. Link the produced framework into the
consuming target before claiming vector-search availability.

Llama framework builds use the app's `build-llama-cpp-mtp.ts` and
`ios-xcframework/build-xcframework.ts` with the canonical local-inference
submodule. There is no separate llama checkout or shim in this directory.
