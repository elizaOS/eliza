# elizaOS Boot Animation

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

`<count>=0` plays until boot completes; the daemon then finishes the current loop and exits. Two parts split a one-shot intro from a looped idle, both required for a clean transition.

## Building

The frames are the white elizaOS face mark on the elizaOS blue field
(`#0B35F1`), rendered from the canonical brand SVG
(`packages/app/public/brand/logos/logo_white_nobg.svg`) — the same source of
truth as the Linux Plymouth splash. Render the frames, then pack the zip:

```bash
# Render part0/ (intro fade-in) + part1/ (idle loop) + desc.txt from the SVG:
node ../../scripts/generate-eliza-bootanimation.mjs
# Pack desc.txt + parts into bootanimation.zip (store mode, no compression):
node ../../scripts/build-eliza-bootanimation.mjs
```

From the package root both steps run via `make bootanimation` (which depends
on `make splash`).

If `bootanimation.zip` is absent, `eliza_common.mk` skips the copy line, and the build falls through to AOSP's default boot animation.

## Generated frames

`part0/`, `part1/`, and `bootanimation.zip` are **regenerated from the brand
SVG** by the scripts above and are `.gitignore`d (the SVG is the source of
truth, not the rendered PNGs). Run `make bootanimation` to (re)produce them.
