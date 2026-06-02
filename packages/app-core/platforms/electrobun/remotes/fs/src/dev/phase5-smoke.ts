import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileRemoteException } from "../bun/errors.ts";
import { FileRemoteService } from "../bun/fs-service.ts";

const originalRoots = process.env.ELIZA_FS_ROOTS;
const originalWrites = process.env.ELIZA_FS_ENABLE_WRITES;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "eliza-fs-"));
const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "eliza-fs-outside-"));
const tempRootRealPath = realpathSync(tempRoot);

try {
  mkdirSync(path.join(tempRoot, "nested"), { recursive: true });
  mkdirSync(path.join(tempRoot, "node_modules"), { recursive: true });
  writeFileSync(
    path.join(tempRoot, "hello.txt"),
    "hello from ElizaLaunch\n",
    "utf8",
  );
  writeFileSync(
    path.join(tempRoot, "nested", "note.txt"),
    "nested note\n",
    "utf8",
  );
  writeFileSync(path.join(tempRoot, ".env"), "SECRET=denied\n", "utf8");
  writeFileSync(path.join(tempRoot, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(
    path.join(tempRoot, "node_modules", "ignored.txt"),
    "ignored text\n",
    "utf8",
  );
  writeFileSync(
    path.join(tempRoot, "..", "outside.txt"),
    "outside via parent\n",
    "utf8",
  );
  writeFileSync(path.join(outsideRoot, "secret.txt"), "outside root\n", "utf8");
  try {
    symlinkSync(
      path.join(outsideRoot, "secret.txt"),
      path.join(tempRoot, "escape-link"),
    );
  } catch {}

  process.env.ELIZA_FS_ROOTS = tempRoot;
  process.env.ELIZA_FS_ENABLE_WRITES = "0";
  const service = new FileRemoteService();

  const roots = await service.roots();
  assert(roots[0]?.path === tempRootRealPath, "roots returns temp root");

  const listing = await service.list({ path: tempRoot });
  assert(
    listing.entries.some((entry) => entry.name === "hello.txt"),
    "list returns hello.txt",
  );
  assert(
    listing.entries.some((entry) => entry.name === "nested"),
    "list returns nested directory",
  );
  assert(
    !listing.entries.some((entry) => entry.name === ".env"),
    "list skips hidden files by default",
  );
  assert(
    !listing.entries.some((entry) => entry.name === "node_modules"),
    "list skips generated folders",
  );

  const read = await service.readText({
    path: path.join(tempRoot, "hello.txt"),
  });
  assert(read.text.includes("hello"), "readText reads hello.txt");

  const search = await service.search({ path: tempRoot, query: "nested" });
  assert(search.matches.length === 1, "search finds nested note");

  const ignoredSearch = await service.search({
    path: tempRoot,
    query: "ignored",
  });
  assert(ignoredSearch.matches.length === 0, "search skips node_modules");

  await expectFileError(
    () => service.readText({ path: path.join(tempRoot, ".env") }),
    "FS_PATH_DENIED",
    ".env is denied",
  );

  await expectFileError(
    () => service.readText({ path: path.join(tempRoot, "binary.dat") }),
    "FS_BINARY_FILE",
    "binary file is denied",
  );

  await expectFileError(
    () => service.readText({ path: path.join(tempRoot, "..", "outside.txt") }),
    "FS_PATH_OUTSIDE_ROOT",
    "parent escape is denied",
  );

  await expectFileError(
    () => service.readText({ path: path.join(tempRoot, "escape-link") }),
    "FS_PATH_OUTSIDE_ROOT",
    "symlink escape is denied",
  );

  await expectFileError(
    () =>
      service.writeText({ path: path.join(tempRoot, "write.txt"), text: "no" }),
    "FS_WRITE_DISABLED",
    "writes are disabled by default",
  );

  if (originalWrites === "1") {
    process.env.ELIZA_FS_ENABLE_WRITES = "1";
    const writeService = new FileRemoteService();
    const written = await writeService.writeText({
      path: path.join(tempRoot, "written.txt"),
      text: "writes enabled\n",
    });
    assert(written.bytesWritten > 0, "writeText writes when enabled");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        root: roots[0]?.path,
        entries: listing.entries.map((entry) => entry.name),
        searchMatches: search.matches.length,
        writesEnabledChecked: originalWrites === "1",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (originalRoots === undefined) delete process.env.ELIZA_FS_ROOTS;
  else process.env.ELIZA_FS_ROOTS = originalRoots;
  if (originalWrites === undefined) delete process.env.ELIZA_FS_ENABLE_WRITES;
  else process.env.ELIZA_FS_ENABLE_WRITES = originalWrites;
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}

async function expectFileError(
  action: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof FileRemoteException && error.code === code) return;
    throw error;
  }
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
