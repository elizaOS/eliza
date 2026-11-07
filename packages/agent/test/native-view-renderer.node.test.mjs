import assert from "node:assert/strict";
import test from "node:test";
import {
  bindNativeViewHost,
  onNativeViewDisconnect,
  registerNativeViewRenderer,
  sendNativeViewFrame,
} from "../src/api/native-view-renderer.ts";

const runtime = () => {
  const controller = new AbortController();
  return { controller, getStopSignal: () => controller.signal };
};
test("native renderer dispatch is runtime, API host and exact client scoped; duplicate subscriptions cannot replace it", () => {
  const a = runtime(),
    b = runtime(),
    host = {},
    foreign = {},
    frames = [];
  assert.throws(
    () => registerNativeViewRenderer(a, "owned", () => true),
    /owning API host/,
  );
  const detachHost = bindNativeViewHost(a, host),
    detach = registerNativeViewRenderer(a, "owned", (frame) => {
      frames.push(frame);
      return true;
    });
  assert.throws(
    () => registerNativeViewRenderer(a, "owned", () => true),
    /already subscribed/,
  );
  assert.equal(sendNativeViewFrame(a, host, "foreign", {}), 0);
  assert.equal(sendNativeViewFrame(a, foreign, "owned", {}), 0);
  assert.equal(sendNativeViewFrame(b, host, "owned", {}), 0);
  const command = { type: "view:interact", requestId: "one" };
  assert.equal(sendNativeViewFrame(a, host, "owned", command), 1);
  assert.deepEqual(frames, [command]);
  let ended = 0;
  onNativeViewDisconnect(a, "owned", () => ended++);
  detach();
  detach();
  assert.equal(ended, 1);
  assert.equal(sendNativeViewFrame(a, host, "owned", command), 0);
  detachHost();
});
test("host retirement and runtime stop revoke native renderer delivery without replay", () => {
  for (const stop of ["host", "runtime"]) {
    const a = runtime(),
      host = {};
    let sent = 0,
      ended = 0;
    const close = bindNativeViewHost(a, host);
    registerNativeViewRenderer(a, "owned", () => {
      sent++;
      return true;
    });
    onNativeViewDisconnect(a, "owned", () => ended++);
    if (stop === "host") close();
    else a.controller.abort();
    assert.equal(ended, 1);
    assert.equal(sendNativeViewFrame(a, host, "owned", {}), 0);
    assert.equal(sent, 0);
    close();
  }
});

test("runtime stopping before listener admission cannot leave a live renderer", () => {
  const controller = new AbortController(),
    signal = controller.signal,
    add = signal.addEventListener.bind(signal);
  signal.addEventListener = (...args) => {
    controller.abort();
    return add(...args);
  };
  const a = { getStopSignal: () => signal },
    host = {};
  let sent = 0;
  const unbind = bindNativeViewHost(a, host),
    close = registerNativeViewRenderer(a, "owned", () => {
      sent++;
      return true;
    });
  assert.equal(signal.aborted, true);
  assert.equal(sendNativeViewFrame(a, host, "owned", {}), 0);
  assert.equal(sent, 0);
  close();
  unbind();
});
