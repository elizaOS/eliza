# ElizaOS Boot Animation

`bootanimation.zip` lands at `/product/media/bootanimation.zip`; AOSP's `bootanimation` daemon plays it during the boot sequence (after the kernel logo, before the framework starts the launcher).

## Format

- Top-level `desc.txt` declares geometry, framerate, and parts.
- Each part is a directory of zero-padded numbered PNGs.
- Frames concatenate; `p` lines tell the daemon how many times to loop and how long to pause between loops.

[Reference](https://android.googlesource.com/platform/frameworks/base/+/master/cmds/bootanimation/FORMAT_SPEC.md).

## desc.txt format used here

```
<width> <height> <fps>
p <count> <pause> <part-name>
```

`<count>=0` plays until boot completes; the daemon then finishes the current loop and exits. Two parts let you split a one-shot intro from a looped idle, both required for a clean transition.

## Building

```bash
node scripts/elizaos/build-bootanimation.mjs --frames assets/boot --out vendor/eliza/bootanimation/bootanimation.zip
```

If `bootanimation.zip` is absent, `eliza_common.mk` skips the copy line, and the build falls through to AOSP's default ANDROID animation.

## Brand frames

The Eliza wordmark frames are intentionally **not** in the repo — they're a brand asset and should be sourced from the design pipeline. Drop the rendered PNG sequence under `vendor/eliza/bootanimation/part0/` (intro) and `vendor/eliza/bootanimation/part1/` (loop), then run the script above.
