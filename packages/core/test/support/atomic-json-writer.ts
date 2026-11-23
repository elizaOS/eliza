// spec/core/atomicWriters.md, "Story: Publish whole snapshots despite interleaved processes"; spec/core/atomicPublication.md, "The final path changes only after a complete temporary file is renamed"
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { writeJsonAtomicPromise, writeJsonAtomicSyncOrThrow } from "../../src/utils/atomic-json.vibe";

const [file, writer, mode, boundary] = process.argv.slice(2);
if (!file || !writer || !mode) throw new Error("Missing writer fixture arguments");
const crash = boundary === "before-rename" || boundary === "after-rename";

if (crash) {
  const rename = fsp.rename;
  fsp.rename = async (source, destination) => {
    if (boundary === "after-rename") await rename(source, destination);
    process.stdout.write(`${boundary}\n`);
    await Effect.runPromise(Effect.forever(Effect.sleep(1_000)));
  };
}

const released = (gate: string) =>
  new Promise<void>((resolve) => {
    const watcher = fs.watch(path.dirname(gate), () => {
      if (!fs.existsSync(gate)) return;
      watcher.close();
      resolve();
    });
    if (fs.existsSync(gate)) {
      watcher.close();
      resolve();
    }
  });

for (let revision = 0; revision < (crash ? 1 : 30); revision++) {
  if (boundary === "pause" && revision === 15) {
    process.stdout.write("paused\n");
    await released(`${file}.go-${writer}`);
  }
  const value = { writer, revision, payload: writer.repeat(16_384) };
  if (mode === "sync") writeJsonAtomicSyncOrThrow(file, value);
  else await writeJsonAtomicPromise(file, value);
}
