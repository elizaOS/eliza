// End-to-end integration test of the REAL TypeScript detector path:
//   yolo-detector.ts -> native/yolo-ffi.ts -> libyolo.dll -> parseYoloV8 -> NMS
// Run from the plugin root with bun so workspace deps (@elizaos/core, sharp)
// resolve:
//   ELIZA_YOLO_GGUF=... ELIZA_YOLO_LIB=... bun native/yolo.cpp/verify/run_ts.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { YOLODetector } from "../../../src/yolo-detector.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const img = readFileSync(join(HERE, "bus.jpg"));

console.error("isAvailable:", await YOLODetector.isAvailable());
const det = new YOLODetector({ scoreThreshold: 0.25, nmsIouThreshold: 0.5 });
await det.initialize();
const objs = await det.detect(img);
console.log(`detections: ${objs.length}`);
for (const o of objs) {
  const b = o.boundingBox;
  console.log(
    `  ${o.type.padEnd(12)} ${o.confidence.toFixed(3)} ` +
      `bbox=(${b.x.toFixed(0)},${b.y.toFixed(0)},${b.width.toFixed(0)},${b.height.toFixed(0)})`,
  );
}
await det.dispose();
