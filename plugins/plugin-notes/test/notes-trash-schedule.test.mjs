import assert from "node:assert/strict";
import test from "node:test";
import { scheduleNotesTrashMaintenance } from "../src/client/notes-trash-schedule.ts";

function fixture() {
  const listeners = new Set(),
    resumes = new Set();
  let tick = null,
    cleared = false,
    runs = 0;
  const visibility = {
    hidden: false,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const stop = scheduleNotesTrashMaintenance({
    run: () => runs++,
    intervalMs: 15 * 60 * 1000,
    visibility,
    onResume: (listener) => {
      resumes.add(listener);
      return () => resumes.delete(listener);
    },
    setInterval: (handler, ms) => {
      assert.equal(ms, 15 * 60 * 1000);
      tick = handler;
      return 7;
    },
    clearInterval: (handle) => {
      assert.equal(handle, 7);
      cleared = true;
    },
  });
  return {
    visibility,
    stop,
    show: () =>
      [...listeners].forEach((l) => {
        l();
      }),
    resume: () =>
      [...resumes].forEach((l) => {
        l();
      }),
    tick: () => tick(),
    get runs() {
      return runs;
    },
    get cleared() {
      return cleared;
    },
    get listeners() {
      return listeners.size + resumes.size;
    },
  };
}

test("foreground, resume and the interval each start a pass; hidden documents do not", () => {
  const f = fixture();
  f.show();
  f.resume();
  f.tick();
  assert.equal(f.runs, 3);
  f.visibility.hidden = true;
  f.show();
  f.resume();
  f.tick();
  assert.equal(f.runs, 3);
});

test("stopping removes every trigger once", () => {
  const f = fixture();
  f.stop();
  f.stop();
  assert.equal(f.cleared, true);
  assert.equal(f.listeners, 0);
  f.tick();
  assert.equal(f.runs, 0);
  assert.throws(() =>
    scheduleNotesTrashMaintenance({ run() {}, intervalMs: 0 }),
  );
});
