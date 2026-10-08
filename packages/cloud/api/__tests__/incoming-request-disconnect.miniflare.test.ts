/** Uses actual loopback HTTP: the worker receives its platform Request.signal. */
import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";

const worker = String.raw`
let aborts = 0;
let cancellations = 0;
export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/receipt") {
      return Response.json({ aborts, cancellations });
    }
    let timer;
    return new Response(new ReadableStream({
      start(controller) {
        request.signal.addEventListener("abort", () => {
          aborts++;
          clearInterval(timer);
          try { controller.close(); } catch {}
        }, { once: true });
        controller.enqueue(new TextEncoder().encode("ready\n"));
        timer = setInterval(() => controller.enqueue(new TextEncoder().encode("ping\n")), 100);
      },
      cancel() { cancellations++; clearInterval(timer); }
    }), { headers: { "content-type": "text/event-stream" } });
  }
};
`;

test("a real incoming HTTP disconnect aborts Workerd Request.signal only with its flag", { timeout: 20000 }, async () => {
  for (const enabled of [false, true]) {
    const mf = new Miniflare({
      host: "127.0.0.1",
      port: 0,
      compatibilityDate: "2026-04-01",
      compatibilityFlags: enabled ? ["enable_request_signal"] : [],
      modules: true,
      script: worker,
    });
    const caller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const origin = (await mf.ready).origin;
      const response = await fetch(`${origin}/stream`, { signal: caller.signal });
      assert.equal(response.status, 200);
      reader = response.body!.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), "ready\n");
      // This closes the client HTTP transport; no signal is injected into fetch().
      caller.abort();
      await assert.rejects(reader.read(), { name: "AbortError" });
      let receipt = { aborts: 0, cancellations: 0 };
      const deadline = Date.now() + 3000;
      do {
        receipt = await (await fetch(`${origin}/receipt`)).json() as typeof receipt;
        if (enabled && receipt.aborts === 1) break;
        if (!enabled && receipt.cancellations > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.equal(receipt.aborts, enabled ? 1 : 0);

    } finally {
      caller.abort();
      reader?.releaseLock();
      await mf.dispose();
    }
  }
});
