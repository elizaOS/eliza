/** Exercises a real Workerd exception across its service binding, private receipt, and unchanged HTTP failure boundary. */
import { expect, test } from "bun:test";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Log, LogLevel, Miniflare } from "miniflare";
import { createPrivateWorkerdFailureCapture } from "../test/workerd-failure-capture";

test("retains nested failure privately while Workerd still returns the original 500", async () => {
  const publicOutput: string[] = [];
  const capture = await createPrivateWorkerdFailureCapture((line) =>
    publicOutput.push(line),
  );
  let miniflare: Miniflare | undefined;
  let rejectDiagnostics = false;
  try {
    const bundle = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL(
            "../test/fixtures/workerd-failure-diagnostics.ts",
            import.meta.url,
          ),
        ),
      ],
      target: "browser",
      format: "esm",
    });
    if (!bundle.success)
      throw new AggregateError(
        bundle.logs,
        "Failed to build diagnostic boundary",
      );
    const boundary = await bundle.outputs[0].text();
    miniflare = new Miniflare({
      compatibilityDate: "2026-04-01",
      log: new Log(LogLevel.NONE),
      serviceBindings: {
        FAILURE_DIAGNOSTICS: async (request: Request) =>
          rejectDiagnostics
            ? new Response(null, { status: 503 })
            : capture.fetch(request),
      },
      modules: [
        {
          type: "ESModule",
          path: "worker.mjs",
          contents: `import { withWorkerdFailureDiagnostics } from './boundary.mjs';
export default { fetch(request, env) {
  return withWorkerdFailureDiagnostics(async () => {
    if (new URL(request.url).pathname === '/success') return new Response('unchanged');
    const secretCause = new Error('private-test-secret-and-model-content');
    const missing = new Error('Eliza Shared runtime completed an executable GENERATE_MEDIA request without an action result', { cause: secretCause });
    const original = new Error('original fixture failure', { cause: missing });
    original.name = 'SharedRuntimeTurnError';
    original.failureName = 'SharedRuntimeActionContractError';
    original.retryable = false;
    throw original;
  }, env.FAILURE_DIAGNOSTICS);
}};`,
        },
        { type: "ESModule", path: "boundary.mjs", contents: boundary },
      ],
    });
    const success = await miniflare.dispatchFetch(
      "https://fixture.test/success",
    );
    expect(success.status).toBe(200);
    expect(await success.text()).toBe("unchanged");
    expect(await readdir(capture.directory)).toEqual([]);
    const response = await miniflare.dispatchFetch(
      "https://fixture.test/failure",
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("original fixture failure");
    const files = await readdir(capture.directory);
    expect(files).toHaveLength(1);
    const receipt = JSON.parse(
      await readFile(join(capture.directory, files[0]), "utf8"),
    );
    expect(
      receipt.causes.map((cause: { message: string }) => cause.message),
    ).toEqual([
      "original fixture failure",
      "Eliza Shared runtime completed an executable GENERATE_MEDIA request without an action result",
      "private-test-secret-and-model-content",
    ]);
    expect(receipt.causes[0]).toMatchObject({
      failureName: "SharedRuntimeActionContractError",
      retryable: false,
    });
    if (process.platform !== "win32") {
      expect((await stat(capture.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(capture.directory, files[0]))).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(publicOutput).toHaveLength(1);
    expect(publicOutput[0]).toContain(
      '"site":"missing-required-GENERATE_MEDIA-result"',
    );
    expect(publicOutput[0]).not.toContain("private-test-secret");
    expect(publicOutput[0]).not.toContain("original fixture failure");
    rejectDiagnostics = true;
    const uncaptured = await miniflare.dispatchFetch(
      "https://fixture.test/failure",
    );
    expect(uncaptured.status).toBe(500);
    expect(await uncaptured.text()).toContain("original fixture failure");
    expect(await readdir(capture.directory)).toEqual(files);
    expect(publicOutput).toHaveLength(1);
  } finally {
    try {
      if (miniflare) await miniflare.dispose();
    } finally {
      await rm(capture.directory, { recursive: true, force: true });
    }
  }
}, 20000);
