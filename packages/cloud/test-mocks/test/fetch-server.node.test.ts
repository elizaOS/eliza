/** Proves the shared HTTP adapter preserves streaming and cancellation in a real Node subprocess. */

import { afterEach, expect, it } from "bun:test";

const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
    await child.exited;
  }
});

async function readLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let line = "";
  while (!line.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Node fixture exited before emitting a line");
    line += decoder.decode(value, { stream: true });
  }
  return line.slice(0, line.indexOf("\n"));
}

it("streams the first chunk without buffering and aborts work on disconnect", async () => {
  const child = Bun.spawn(
    [
      "node",
      "--experimental-strip-types",
      "test/fixtures/fetch-server-node-stream.ts",
    ],
    {
      cwd: import.meta.dir.replace(/\/test$/, ""),
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  children.push(child);
  const stdout = child.stdout.getReader();
  const port = Number(await readLine(stdout));
  expect(Number.isInteger(port)).toBe(true);

  const startedAt = performance.now();
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/stream`, {
    signal: controller.signal,
  });
  const body = response.body?.getReader();
  if (!body) throw new Error("Node fixture returned no response body");
  const first = await body.read();
  expect(new TextDecoder().decode(first.value)).toBe("first\n");
  expect(performance.now() - startedAt).toBeLessThan(750);

  controller.abort("test disconnect");
  expect(await readLine(stdout)).toBe("aborted");
});
