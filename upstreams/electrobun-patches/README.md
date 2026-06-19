# elizaOS patches on top of Electrobun v1.18.1

Tag pinned: `v1.18.1` (commit `4eba723c85b97559e1d9e13439d9a92ede0832e8`).

Upstream: <https://github.com/blackboardsh/electrobun>.

## Why we fork

The packaged `elizaos.app` bundle (under
`packages/os/linux/elizaos/artifacts/amd64/elizaos-app/`) ships
`libNativeWrapper.so` v1.0.2 from this Electrobun release. In every QEMU graphics
configuration we tested, the serial log stops after:

```
=== ELECTROBUN NATIVE WRAPPER VERSION 1.0.2 === GTK EVENT LOOP STARTED ===
```

A previous strace showed bun's main thread blocking in `do_sys_poll`.

## What we found before patching

Reading the upstream wrapper at
`package/src/native/linux/nativeWrapper.cpp` (v1.18.1, lines 6296–6305):

```cpp
void runGTKEventLoop() {
    initializeGTK();
    printf("=== ELECTROBUN NATIVE WRAPPER VERSION 1.0.2 === GTK EVENT LOOP STARTED ===\n");
    // no fflush
    gtk_main();          // blocks in poll() on the X11 fd — by design
    g_shutdownComplete.store(true);
}
```

The launcher (`package/src/launcher/main.ts`, lines 241–252) spawns a bun
`Worker` that runs the app's `bun/index.js` and then synchronously calls
`startEventLoop()` on the main thread. `gtk_main()` blocking in `poll()` is the
correct, expected behavior — it is the GTK event loop waiting for X11 events.
It is **not** a deadlock by itself.

That means the wrapper has **no code that runs after `gtk_main()` enters** until
the Worker thread starts making FFI calls (`createX11Window`, `initWebview`, …)
that are marshalled onto the main thread via
`dispatch_sync_main` / `dispatch_sync_main_void` (lines 5673–5798).

So the actual failure has to be one of:

1. The Worker thread is wedged in JS module init and never makes its first FFI
   call. The wrapper would then sit forever in `gtk_main()` correctly polling
   for X11 events that nothing is going to generate, which looks identical from
   the outside to a "wrapper deadlock".
2. `stdout` is fully block-buffered (we are not on a TTY — output is going via
   `systemd-cat` to the kernel ring buffer), so the Worker has emitted output
   that is sitting in libc's stdout buffer indefinitely and never makes it to
   serial.
3. The Worker did make a first FFI call into the wrapper and `g_idle_add` /
   the GTK main loop didn't pick it up under QEMU's virtio-gpu / llvmpipe path.

(1) and (2) are bun/app-bundle problems, not wrapper problems. (3) would be a
real wrapper bug. The next-run diagnostic patch below distinguishes them.

## The patch (diagnostic, not a "fix that hides the bug")

`package/src/native/linux/nativeWrapper.cpp`:

1. Set `setvbuf(stdout, nullptr, _IOLBF, 0)` at the top of `runGTKEventLoop` so
   every subsequent `printf("…\n")` is flushed immediately. This eliminates (2)
   as a candidate for the silent-after-this-line behavior.
2. Add a `g_timeout_add_seconds(1, …)` heartbeat
   `[wrapper-heartbeat] gtk_main alive tick=N`. If this stream stops, `gtk_main`
   itself has wedged (a real wrapper bug). If it continues forever with no
   other wrapper output, the Worker has not made a single FFI call — (1) is the
   cause, and the next investigation moves into bun's Worker startup.
3. Add a one-shot `[wrapper-dispatch] first dispatch_sync_main…` log to both
   `dispatch_sync_main` and `dispatch_sync_main_void`. If the heartbeat ticks
   but this never appears, the Worker is alive in some sense but never reaches
   the point of creating its first X11 window / WebView. If it does appear and
   then the heartbeat stops, the bug is in whatever the first dispatched
   callback does (likely `XOpenDisplay` / `webkit_web_view_new` under the QEMU
   GL backend).

This is intentionally a *diagnostic* patch, not a "swallow the symptom" patch.
The brief's premise that the bug is in "wrapper code after `gtk_main()`" was
not supported by reading the source. Before we can write a real fix we need
the next-run logs to say *which* of (1)/(2)/(3) it actually is.

## Building the patched wrapper

The wrapper is a single C++ TU compiled with `g++` against pkg-config-resolved
`webkit2gtk-4.1 gtk+-3.0` (and optionally `ayatana-appindicator3-0.1`). It does
*not* require the full Electrobun build pipeline (no CEF, no Dawn/WGPU, no Zig
launcher rebuild) when all we are replacing is `libNativeWrapper.so` in an
already-built bundle.

### Host prerequisites (Ubuntu 24.04)

```
sudo apt-get install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev \
    pkg-config g++
```

### Build command (linux-x64)

```
cd eliza/upstreams/electrobun/package

mkdir -p src/native/linux/build src/native/build

PKG_CFLAGS=$(pkg-config --cflags webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1)
PKG_LIBS=$(pkg-config --libs   webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1)

g++ -c -std=c++20 -fPIC $PKG_CFLAGS \
    -I vendors/cef \
    -o src/native/linux/build/nativeWrapper.o \
       src/native/linux/nativeWrapper.cpp

g++ -shared \
    -o src/native/build/libNativeWrapper.so \
       src/native/linux/build/nativeWrapper.o \
       vendors/zig-asar/libasar.so \
       $PKG_LIBS \
       -ldl -lpthread
```

If `ayatana-appindicator3-0.1` is unavailable, drop it from both `pkg-config`
calls and add `-DNO_APPINDICATOR` to the compile step (matches upstream's
`build.ts` lines 1934–1955 fallback).

If `vendors/cef` / `vendors/zig-asar` are absent (a fresh submodule clone has
neither, they are downloaded by `bun build.ts`), the cheapest way to obtain
them is one-time:

```
cd eliza/upstreams/electrobun/package && bun install && bun build.ts
```

…which produces `dist/libNativeWrapper.so` directly. The two-step manual `g++`
above is only useful for fast iteration on the wrapper itself.

### Installing the patched wrapper into the bundle

```
cp src/native/build/libNativeWrapper.so \
   <repo-root>/packages/os/linux/elizaos/artifacts/amd64/elizaos-app/bin/libNativeWrapper.so
```

Then rebuild the ISO via `packages/os/linux/elizaos/`'s normal pipeline
(`build.sh` / `Makefile`) so the new wrapper is staged onto the live image.

## riscv64

The same wrapper TU has to be cross-compiled for `riscv64-linux-gnu`. The
constraints:

- **GTK3 + WebKit2GTK on riscv64 Debian.** `apt-cache search` on a Debian
  unstable riscv64 chroot lists `libgtk-3-dev` and `libwebkit2gtk-4.1-dev`, but
  the latter has historically lagged on riscv64 (JIT support gaps in
  JavaScriptCore on rv64). The pragmatic path is to build in a riscv64 sysroot
  (debootstrap `sid` on `riscv64`) and link against whatever
  `pkg-config --libs webkit2gtk-4.1` resolves to inside that sysroot.
- **Cross toolchain.** `riscv64-linux-gnu-g++` (cross from amd64 host) plus a
  riscv64 sysroot exported via `--sysroot=…` and
  `PKG_CONFIG_SYSROOT_DIR=… PKG_CONFIG_PATH=…/usr/lib/pkgconfig`.
- **Reuse `bun-riscv64`.** `packages/app-core/scripts/bun-riscv64/` already
  cross-builds bun for riscv64 in a Debian-based Dockerfile; the cleanest
  integration is to add a sibling stage in that same Dockerfile that
  `apt-get install`s `libwebkit2gtk-4.1-dev libgtk-3-dev` and runs the same
  two-step `g++` build above, producing
  `artifacts/riscv64/libNativeWrapper.so` for the rv64 ISO to consume.
- **No CEF on riscv64.** CEF doesn't publish rv64 binaries; the wrapper must
  be built without the CEF code paths (`isCEFAvailable()` is a runtime check
  that returns false when `vendors/cef` is missing). We already only ship the
  GTK-only `libNativeWrapper.so` in the amd64 bundle, so this is consistent.

The Zig launcher in `package/src/extractor/` is already cross-targetable via
Zig's built-in `riscv64-linux-gnu` target — that part is the same story as the
bun-riscv64 pipeline, no new infrastructure needed.
