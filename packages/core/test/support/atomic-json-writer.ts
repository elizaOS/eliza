// spec/core/atomicWriters.md, "Story: Publish whole snapshots despite interleaved processes"; spec/core/atomicPublication.md, "The final path changes only after a complete temporary file is renamed"
import fsp from "node:fs/promises";
import { writeJsonAtomicPromise, writeJsonAtomicSyncOrThrow } from "../../src/utils/atomic-json.vibe";

const [file, writer, mode, boundary] = process.argv.slice(2);
if (!file || !writer || !mode) throw new Error("Missing writer fixture arguments");

if (boundary) {
  const rename = fsp.rename;
  fsp.rename = async (source, destination) => {
    if (boundary === "after-rename") await rename(source, destination);
    process.stdout.write(`${boundary}\n`);
    setInterval(() => undefined, 1_000);
    await new Promise<void>(() => undefined);
  };
}

for (let revision = 0; revision < (boundary ? 1 : 30); revision++) {
  const value = { writer, revision, payload: writer.repeat(16_384) };
  if (mode === "sync") writeJsonAtomicSyncOrThrow(file, value);
  else await writeJsonAtomicPromise(file, value);
}
