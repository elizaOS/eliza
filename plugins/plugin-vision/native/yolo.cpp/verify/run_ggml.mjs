// Run the ggml yolo.dll on verify/input.bin and write verify/out.bin [84,8400].
// Standalone bun:ffi harness (does not depend on the TS plugin) so the native
// runtime can be checked against the PyTorch reference in isolation.
//
//   bun verify/run_ggml.mjs <yolo.dll> <yolov8n.gguf>
import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dll = process.argv[2];
const gguf = process.argv[3];
if (!dll || !gguf) {
  console.error("usage: bun run_ggml.mjs <yolo.dll> <yolov8n.gguf>");
  process.exit(2);
}

const lib = dlopen(dll, {
  yolo_init: { args: [FFIType.cstring], returns: FFIType.pointer },
  yolo_run: {
    args: [
      FFIType.pointer, // ctx
      FFIType.pointer, // rgb_chw
      FFIType.i32, // h
      FFIType.i32, // w
      FFIType.pointer, // out_logits
      FFIType.pointer, // out_channels
      FFIType.pointer, // out_anchors
    ],
    returns: FFIType.i32,
  },
  yolo_classes: { args: [FFIType.pointer], returns: FFIType.cstring },
  yolo_free: { args: [FFIType.pointer], returns: FFIType.void },
});

const ggufZ = Buffer.from(`${gguf}\0`, "utf8");
const ctx = lib.symbols.yolo_init(ptr(ggufZ));
if (!ctx) {
  console.error("yolo_init returned NULL");
  process.exit(1);
}

const classesPtr = lib.symbols.yolo_classes(ctx);
const classes = classesPtr ? new CString(classesPtr).toString() : "";
console.error(`classes: ${classes.split(/\r?\n/).filter(Boolean).length}`);

const input = new Float32Array(
  readFileSync(join(HERE, "input.bin")).buffer.slice(0),
);
console.error(`input floats: ${input.length} (expected ${3 * 640 * 640})`);

const out = new Float32Array(84 * 8400);
const outChan = new Int32Array(1);
const outAnch = new Int32Array(1);

const t0 = performance.now();
const rc = lib.symbols.yolo_run(
  ctx,
  ptr(input),
  640,
  640,
  ptr(out),
  ptr(outChan),
  ptr(outAnch),
);
const dt = performance.now() - t0;
console.error(
  `yolo_run rc=${rc} channels=${outChan[0]} anchors=${outAnch[0]} (${dt.toFixed(0)}ms)`,
);
if (rc !== 0) {
  lib.symbols.yolo_free(ctx);
  process.exit(1);
}

writeFileSync(join(HERE, "out.bin"), Buffer.from(out.buffer));
lib.symbols.yolo_free(ctx);
console.error("wrote out.bin");
