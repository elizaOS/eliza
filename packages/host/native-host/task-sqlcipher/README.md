# Explicit SQLCipher task provider

Candidate N-API driver for the task store's synchronous `exec`, `prepare().get/run`
and `close` interface. The host supplies an absolute native library path, its
reviewed SHA-256, independent ELF machine and explicit library mode, plus an authorized `resolveKey`
callback returning a disposable 32-byte key. Importing this module opens nothing.
No environment flag enables encryption, no key is placed in SQL or command-line
arguments, and no ordinary SQLite fallback or migration exists.

Build on Linux with Node 24.15.0 headers, C compiler, Perl, Make and tar:

```
node packages/host/native-host/task-sqlcipher/build.mjs /absolute/fresh-output /absolute/node/include/node linux-x64 /usr/bin/cc
ELIZA_TASK_SQLCIPHER_BUILD=/absolute/fresh-output/build.json node --test packages/host/native-host/task-sqlcipher/integration.mjs
ELIZA_TASK_SQLCIPHER_BUILD=/absolute/fresh-output/build.json bun test ./packages/host/native-host/task-sqlcipher/integration.mjs
```

`sources.json` pins SQLCipher Community (BSD-3-Clause) and OpenSSL (Apache-2.0)
archives by hash. Build output retains their licenses. OpenSSL and SQLCipher are
statically linked with local symbols; only N-API registration symbols are
exported. Builds use one Make job and refuse reused extracted source directories.
The build manifest records compiler/header/source hashes and the actual ELF.
It does not assert runtime qualification.

For Android Bun, use `x86_64-linux-musl` or `aarch64-linux-musl` and an explicit
compiler executable targeting that triple. Bionic/NDK addons are not compatible
with the embedded musl runtime. A consumer must package the exact library and
licenses with a reviewed artifact manifest, then test it inside the installed
app UID/SELinux domain. Host tests do not establish either Android ABI's readiness.
The current recipe has no automatic APK inventory adoption.

Native open applies the raw key through `sqlite3_key_v2` before schema access,
then verifies exact cipher version, keyed schema read, integrity, memory temp
storage and full synchronization. Caller SQL cannot attach/export a plaintext
copy or change key/temp/durability policy. The provider rechecks the connection
before task-store admission. Its schema is compatible with ordinary task-store
SQL, but plaintext databases and wrong keys are refused without migration.

Qualification requires actual Node and Bun encryption/integrity/wrong-key/plain
SQLite tests, WAL/process-death recovery, temp/canary scanning and both target
ABI proofs. Key custody, authorized account binding, migration, revocation and
non-database evidence/journal encryption remain separate host responsibilities.

`libraryMode: "installed-readonly"` requires a regular library owned by a different
OS identity with no group/world write access; its privileged installer is trusted.
`libraryMode: "private-snapshot"` loads a verified copy from an unlinked private
file for host qualification. Both use a pinned file descriptor, retained once per
loaded library for the process lifetime to prevent `dlopen` pathname-cache reuse.
Failure closes the descriptor and removes temporary files. The Android lane must
separately prove `/proc/self/fd` loading under its musl/SELinux configuration.

The database parent must be canonical, owned by the process UID and mode 0700;
existing DBs must be single-link regular files owned by that UID with mode 0600.
New files are created exclusively with mode 0600 before SQLite opens them with
`SQLITE_OPEN_NOFOLLOW`. A malicious same-UID process or privileged installer is
outside this in-process host boundary: neither callbacks nor filesystem paths
establish account authorization. Actual tests inspect DB/WAL/SHM permissions.
