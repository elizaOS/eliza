# sqlite-vec — iOS static build

`sqlite-vec` is a SQLite extension that adds vector storage + similarity
search via a `vec0` virtual-table module and SQL helpers
(`vec_distance_l2`, `vec_distance_cosine`, `vec_distance_hamming`,
`vec_length`).

Upstream: https://github.com/asg017/sqlite-vec
Licence: Apache-2.0 OR MIT
Pinned tag: see `../VERSIONS` (`sqlite-vec=<tag>`)

## Why we ship this

The agent's `plugin-sql` uses pgvector-style `vector(N)` columns for
embedding storage and KNN queries. PGlite (which is what plugin-sql uses
on every other platform) cannot run inside JSContext on iOS 16.4+ because
WebAssembly is gated off — so the iOS port falls back to native SQLite
via the `__MILADY_BRIDGE__.sqlite_*` host functions. `sqlite-vec` is the
drop-in replacement for pgvector inside that SQLite backend.

The PGlite shim (`polyfill/src/modules/pglite-shim.ts`) rewrites
`vector(N)` column types in CREATE TABLE statements to `BLOB`, and
plugin-sql call sites that build similarity queries need to swap their
pgvector operators (`<->`, `<=>`, `cosine_distance(...)`) for
sqlite-vec's `vec_distance_l2(...)` / virtual-table `MATCH` syntax. That
swap is a separate plugin-sql change, outside this package.

## How to build (manual; do not run inside CI yet)

```bash
# 1. Clone at the pinned tag.
cd packages/ios-native-deps/sqlite-vec
git clone --depth 1 --branch <tag> https://github.com/asg017/sqlite-vec src

# 2. Configure for iOS arm64 (device).
cmake -S src -B build-ios-arm64 \
  -DCMAKE_TOOLCHAIN_FILE=../../toolchain/ios.cmake \
  -DPLATFORM=OS64 \
  -DBUILD_SHARED_LIBS=OFF \
  -DSQLITE_VEC_ENABLE_AVX=OFF \
  -DSQLITE_VEC_ENABLE_NEON=ON

cmake --build build-ios-arm64 --config Release

# 3. Configure for iOS arm64 simulator (Apple Silicon Mac).
cmake -S src -B build-ios-sim-arm64 \
  -DCMAKE_TOOLCHAIN_FILE=../../toolchain/ios.cmake \
  -DPLATFORM=SIMULATORARM64 \
  -DBUILD_SHARED_LIBS=OFF

cmake --build build-ios-sim-arm64 --config Release

# 4. Bundle both slices into an xcframework.
xcodebuild -create-xcframework \
  -library build-ios-arm64/libsqlite_vec.a \
  -headers src/sqlite-vec.h \
  -library build-ios-sim-arm64/libsqlite_vec.a \
  -headers src/sqlite-vec.h \
  -output SqliteVec.xcframework
```

## Linking into the Capacitor pod

Once `SqliteVec.xcframework` exists, append it to
`ElizaosCapacitorBunRuntime.podspec`:

```ruby
s.vendored_frameworks = [
  'ios/Frameworks/LlamaCpp.xcframework',
  'ios/Frameworks/SqliteVec.xcframework',  # ← new
]
```

The Swift side (`SqliteVecLoader.swift`) calls a small direct-link C shim. The
shim weak-imports `sqlite3_vec_init`, so dev builds can run without sqlite-vec,
while production builds avoid dynamic-loader APIs.

## Verifying the link

After rebuilding the host app:

```swift
print(SqliteVecLoader.shared.isAvailable)   // true when linked
print(SqliteVecLoader.shared.versionString) // "v0.x.y" when linked
```

And from JS:

```js
const v = __MILADY_BRIDGE__.sqlite_version();
console.log(v.sqlite, v.sqlite_vec);
```

## Current status

**Not yet linked.** The static lib has not been built and dropped into
the Pod. The Swift loader compiles fine without it (it falls back to a
no-op), and the JS shim still works for non-vector queries. The agent
will need this extension before embeddings + similarity search work on
iOS.

When you build the lib, also bump the pin in `../VERSIONS`.
