import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";

const engines = { chromium, firefox, webkit };
const selected = process.argv.slice(2);
assert.ok(selected.every(name => Object.hasOwn(engines, name)), "Choose chromium, firefox or webkit");
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../browser-document-store.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", write: false,
});
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/store.js" ? "text/javascript" : "text/html");
  response.end(request.url === "/store.js" ? bundle.outputFiles[0].contents : "<!doctype html><title>Document transactions</title>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
try {
  for (const [name, engine] of Object.entries(engines).filter(([name]) => selected.length === 0 || selected.includes(name))) {
    const browser = await engine.launch({ headless: true });
    const deadline = setTimeout(() => {
      console.error(`${name}: document-store checks exceeded 60 seconds`);
      void browser.close();
    }, 60000);
    try {
      const context = await browser.newContext();
      const a = await context.newPage(), b = await context.newPage();
      for (const page of [a, b]) {
        await page.goto(url);
        await page.evaluate(async () => {
          const { BrowserDocumentStore } = await import("/store.js");
          window.store = new BrowserDocumentStore("transaction-test");
        });
      }
      // Rapid acquisition reproduces the localStorage/Web Locks lost-update case.
      const write = (page, owner) => page.evaluate(async owner => {
        const receipts = [];
        for (let i = 0; i < 100; i++) {
          localStorage.getItem("snapshot-primer");
          receipts.push(await window.store.edit("rapid", async before => {
            const items = before ? JSON.parse(before.raw) : [];
            items.push(`${owner}:${i}`);
            return { raw: JSON.stringify(items), result: items.length };
          }));
        }
        return receipts;
      }, owner);
      const receipts = (await Promise.all([write(a, "a"), write(b, "b")])).flat().sort((a, b) => a - b);
      assert.deepEqual(receipts, Array.from({ length: 200 }, (_, i) => i + 1));
      const items = await b.evaluate(async () => JSON.parse((await window.store.read("rapid")).raw));
      assert.deepEqual(items.sort(), ["a", "b"].flatMap(owner => Array.from({ length: 100 }, (_, i) => `${owner}:${i}`)).sort());
      console.log(`${name}: all 200 cross-tab updates and receipts retained`);

      // Concurrent initialization must return one receipt without rewriting existing bytes.
      const initialize = (page, owner) => page.evaluate(async owner => {
        return Promise.all(Array.from({length: 20}, (_, i) => window.store.readOrCreate("initialize", `${owner}:${i}`)));
      }, owner);
      const initialized = (await Promise.all([initialize(a, "a"), initialize(b, "b")])).flat();
      assert.equal(new Set(initialized.map(row => row.revision)).size, 1);
      assert.equal(new Set(initialized.map(row => row.raw)).size, 1);
      const initializeState = await a.evaluate(async () => {
        const before = await window.store.read("initialize");
        const tombstone = await window.store.compareExchange("initialize", before, null);
        const kept = await window.store.readOrCreate("initialize", "must not resurrect");
        const abort = new AbortController();abort.abort();let cancelled;
        try { await window.store.readOrCreate("cancelled-initialize", "lost", abort.signal); } catch(e) {cancelled=e.name;}
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(){throw new DOMException("Full", "QuotaExceededError");};
        let failed, stable;
        try {
          stable = await window.store.readOrCreate("initialize", "must not write");
          try { await window.store.readOrCreate("failed-initialize", "lost"); } catch(e) {failed=e.name;}
        } finally {IDBObjectStore.prototype.put=put;}
        return {tombstone,kept,stable,cancelled,failed,cancelledRecord:await window.store.read("cancelled-initialize"),failedRecord:await window.store.read("failed-initialize")};
      });
      assert.deepEqual(initializeState.kept, initializeState.tombstone);
      assert.deepEqual(initializeState.stable, initializeState.tombstone);
      assert.equal(initializeState.cancelled, "AbortError");
      assert.equal(initializeState.failed, "QuotaExceededError");
      assert.equal(initializeState.cancelledRecord, undefined);
      assert.equal(initializeState.failedRecord, undefined);
      console.log(`${name}: concurrent initialization, stable tombstones, cancellation and quota failure pass`);

      // Initialization must not invalidate an asynchronous edit that already owns the key.
      const coordinated = await a.evaluate(async () => {
        let release, started;
        const ready = new Promise(resolve => { started = resolve; });
        const editing = window.store.edit("initialize-during-edit", async () => {
          started();
          await new Promise(resolve => { release = resolve; });
          return { raw: "edited", result: "committed" };
        }).then(value => ({value}), error => ({error:error.name}));
        await ready;
        let initialized = false;
        const creating = window.store.readOrCreate("initialize-during-edit", "legacy").then(value => { initialized = true; return value; });
        await new Promise(resolve => setTimeout(resolve, 30));
        const premature = initialized;
        release();
        return {premature, editing:await editing, initialized:await creating, saved:await window.store.read("initialize-during-edit")};
      });
      assert.equal(coordinated.premature, false);
      assert.deepEqual(coordinated.editing, {value:"committed"});
      assert.equal(coordinated.initialized.raw, "edited");
      assert.deepEqual(coordinated.initialized, coordinated.saved);
      console.log(`${name}: initialization preserves an in-flight asynchronous editor`);

      const unlockedInitialization = await a.evaluate(async () => {
        const locks = navigator.locks;
        Object.defineProperty(navigator, "locks", {configurable:true, value:undefined});
        try { return await Promise.all(Array.from({length:20}, (_, i) => window.store.readOrCreate("initialize-without-locks", String(i)))); }
        finally { Object.defineProperty(navigator, "locks", {configurable:true, value:locks}); }
      });
      assert.equal(new Set(unlockedInitialization.map(row => row.revision)).size, 1);
      assert.equal(new Set(unlockedInitialization.map(row => row.raw)).size, 1);

      // CAS works without the optional editor lock; two creators cannot both win.
      const create = page => page.evaluate(async () => {
        try { return { saved: await window.store.compareExchange("create", undefined, "original") }; }
        catch (e) { return { error: e.name }; }
      });
      const created = await Promise.all([create(a), create(b)]);
      assert.equal(created.filter(row => row.saved).length, 1);
      assert.equal(created.filter(row => row.error === "BrowserDocumentConflict").length, 1);
      const initial = created.find(row => row.saved).saved;

      // Reset keeps a tombstone. Recreating identical bytes cannot validate an old receipt.
      const recovery = await a.evaluate(async initial => {
        const reset = await window.store.compareExchange("create", initial, null);
        const restored = await window.store.compareExchange("create", reset, initial.raw);
        let error;
        try { await window.store.compareExchange("create", initial, "lost"); } catch (e) { error = e.name; }
        const broken = "{ malformed\n\u0000";
        await window.store.compareExchange("corrupt", undefined, broken);
        return { reset, restored, error, raw: (await window.store.read("corrupt")).raw, broken };
      }, initial);
      assert.equal(recovery.reset.raw, null);
      assert.equal(recovery.restored.raw, initial.raw);
      assert.notEqual(recovery.restored.revision, initial.revision);
      assert.equal(recovery.error, "BrowserDocumentConflict");
      assert.equal(recovery.raw, recovery.broken);
      console.log(`${name}: creation conflict, reset ABA and exact corrupt-byte recovery pass`);

      const failures = await a.evaluate(async () => {
        const errors = [];
        const controller = new AbortController();
        try { await window.store.edit("create", async () => { throw Error("editor failure"); }); }
        catch (e) { errors.push(e.message); }
        try {
          await window.store.edit("create", async () => {
            controller.abort(new Error("cancelled editor"));
            return { raw: "lost", result: "false success" };
          }, controller.signal);
        } catch (e) { errors.push(e.message); }
        // An actual IDB write exception aborts the transaction and retains the receipt.
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () { throw new DOMException("Storage full", "QuotaExceededError"); };
        try { await window.store.compareExchange("create", await window.store.read("create"), "lost"); }
        catch (e) { errors.push(e.name); }
        finally { IDBObjectStore.prototype.put = put; }
        return { errors, saved: await window.store.read("create") };
      });
      assert.deepEqual(failures.errors.slice(0, 2), ["editor failure", "cancelled editor"]);
      assert.equal(failures.errors[2], "QuotaExceededError");
      assert.equal(failures.saved.raw, "original");
      console.log(`${name}: editor failure, cancellation and failed transaction preserve saved bytes`);

      await a.evaluate(() => {
        window.cancelEdit = new AbortController();
        window.pending = window.store.edit("cancelled", async () => {
          await new Promise(resolve => { window.finishCancelled = resolve; });
          return { raw: "late cancelled bytes", result: true };
        }, window.cancelEdit.signal).catch(e => e.name);
      });
      await a.waitForFunction(() => typeof window.finishCancelled === "function");
      assert.equal(await a.evaluate(async () => { window.cancelEdit.abort(); return window.pending; }), "AbortError");
      await b.evaluate(async () => window.store.edit("cancelled", async () => ({ raw: "new owner", result: true })));
      await a.evaluate(() => window.finishCancelled());
      assert.equal(await a.evaluate(async () => (await window.store.read("cancelled")).raw), "new owner");
      console.log(`${name}: cancellation releases a hanging editor and rejects its late result`);

      // External CAS during an async editor is detected; its callback is never replayed.
      await a.evaluate(() => {
        window.calls = 0;
        window.pending = window.store.edit("create", async () => {
          window.calls++;
          await new Promise(resolve => { window.release = resolve; });
          return { raw: "stale editor", result: true };
        }).catch(e => e.name);
      });
      await a.waitForFunction(() => typeof window.release === "function");
      await b.evaluate(async () => window.store.compareExchange("create", await window.store.read("create"), "other tab"));
      const conflict = await a.evaluate(async () => { window.release(); return { error: await window.pending, calls: window.calls }; });
      assert.deepEqual(conflict, { error: "BrowserDocumentConflict", calls: 1 });

      await a.evaluate(() => {
        window.release = undefined;
        void window.store.edit("abandoned", async () => {
          window.entered = true;
          await new Promise(() => {});
          return { raw: "uncommitted", result: true };
        });
      });
      await a.waitForFunction(() => window.entered);
      await a.close();
      assert.equal(await b.evaluate(async () => window.store.edit("abandoned", async before => ({ raw: "survivor", result: before === undefined }))), true);
      await b.reload();
      const afterReload = await b.evaluate(async () => {
        const { BrowserDocumentStore } = await import("/store.js");
        return new BrowserDocumentStore("transaction-test").read("abandoned");
      });
      assert.equal(afterReload.raw, "survivor");
      console.log(`${name}: async conflict, tab death and reload recovery pass`);
    } finally { clearTimeout(deadline); await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
