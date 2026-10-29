import assert from "node:assert/strict";
import { test } from "node:test";

const {
  defaultShadeFallbackCopy,
  emptyHomePullEligible,
  emptyHomeShadePull,
  installOverflowPull,
  overflowPullDecision,
  PULL_SLOP,
  readPullStart,
  requestNotificationShade,
  SHADE_PULL_THRESHOLD,
  STATUS_BAND,
  shadeFallback,
  shadeSurface,
} = await import("../src/client/shade.ts");

const copy = defaultShadeFallbackCopy("Example Phone");
const home = {
  launcher: true,
  assistant: false,
  screen: "home",
  view: null,
  chat: "input",
  voice: "off",
  drawer: false,
  secure: false,
  shade: false,
};
const empty = { home: true, editable: false, keyboard: false, scrolled: false };

test("Android answers on a device, the stand-in only in a development browser", () => {
  assert.equal(shadeSurface({ native: true, simulated: true }), "android");
  assert.equal(shadeSurface({ native: false, simulated: true }), "simulated");
  assert.equal(shadeSurface({ native: false, simulated: false }), "none");
});

test("the fallback never claims the shade opened and names the product", () => {
  assert.equal(shadeFallback("opened", copy), "");
  assert.match(
    shadeFallback("not-in-front", copy),
    /^Example Phone is not in front\./,
  );
  assert.equal(shadeFallback("standalone", copy), copy.standalone);
  for (const outcome of ["unsupported", undefined, null, "opened ", 7])
    assert.equal(shadeFallback(outcome, copy), copy.unavailable);
  const custom = { notInFront: "a", standalone: "b", unavailable: "c" };
  assert.deepEqual(
    ["not-in-front", "standalone", "denied"].map((o) =>
      shadeFallback(o, custom),
    ),
    ["a", "b", "c"],
  );
});

test("a clearly downward pull on empty launcher Home asks for the shade", () => {
  assert.equal(emptyHomeShadePull(home, empty, 300, 0, 120), true);
  assert.equal(
    emptyHomeShadePull(home, empty, STATUS_BAND, 10, SHADE_PULL_THRESHOLD + 1),
    true,
  );
  assert.equal(emptyHomePullEligible(home), true);
});

test("anything over Home, or a pull that is not empty Home's, does not", () => {
  const covered = [
    { launcher: false },
    { assistant: true },
    { secure: true },
    { shade: true },
    { screen: "lock" },
    { view: "notes" },
    { drawer: true },
    { voice: "listening" },
    { chat: "sheet" },
    { chat: "full" },
  ];
  for (const patch of covered) {
    const context = { ...home, ...patch };
    assert.equal(
      emptyHomeShadePull(context, empty, 300, 0, 120),
      false,
      JSON.stringify(patch),
    );
    assert.equal(emptyHomePullEligible(context), false, JSON.stringify(patch));
  }
  // Too short, sideways, upward, or from the status bar band Android already answered.
  assert.equal(
    emptyHomeShadePull(home, empty, 300, 0, SHADE_PULL_THRESHOLD),
    false,
  );
  assert.equal(emptyHomeShadePull(home, empty, 300, 100, 120), false);
  assert.equal(emptyHomeShadePull(home, empty, 300, 0, -120), false);
  assert.equal(emptyHomeShadePull(home, empty, STATUS_BAND - 1, 0, 120), false);
  for (const start of [
    null,
    undefined,
    { ...empty, home: false },
    { ...empty, editable: true },
    { ...empty, keyboard: true },
    { ...empty, scrolled: true },
  ])
    assert.equal(
      emptyHomeShadePull(home, start, 300, 0, 120),
      false,
      JSON.stringify(start),
    );
});

test("an overflowing Home claims only a clearly downward drag past the slop", () => {
  assert.equal(overflowPullDecision(false, 0, 40), "release");
  assert.equal(overflowPullDecision(true, 1, PULL_SLOP - 1), "wait");
  assert.equal(overflowPullDecision(true, 2, PULL_SLOP), "claim");
  assert.equal(overflowPullDecision(true, 0, -PULL_SLOP), "release");
  assert.equal(overflowPullDecision(true, 20, 10), "release");
});

test("a failed or refused native request reads as its fallback", async () => {
  assert.equal(
    await requestNotificationShade(
      { openNotificationShade: async () => ({ status: "opened" }) },
      copy,
    ),
    "",
  );
  assert.equal(
    await requestNotificationShade(
      { openNotificationShade: async () => ({ status: "not-in-front" }) },
      copy,
    ),
    copy.notInFront,
  );
  assert.equal(
    await requestNotificationShade(
      { openNotificationShade: async () => undefined },
      copy,
    ),
    copy.unavailable,
  );
  assert.equal(
    await requestNotificationShade(
      {
        openNotificationShade: async () => {
          throw new Error("no");
        },
      },
      copy,
    ),
    copy.unavailable,
  );
});

/** A minimal element tree: enough DOM for closest/matches/scroll reads. */
function dom() {
  class FakeElement {
    constructor(name, attrs = {}, parent = null) {
      Object.assign(this, {
        name,
        attrs,
        parentElement: parent,
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 100,
        ownerDocument: doc,
      });
    }
    matches(selector) {
      return selector.split(",").some((part) => {
        const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(part.trim());
        if (attr)
          return (
            attr[1] in this.attrs &&
            (attr[2] === undefined || this.attrs[attr[1]] === attr[2])
          );
        return part.trim() === this.name;
      });
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement)
        if (node.matches(selector)) return node;
      return null;
    }
  }
  const doc = { body: null, activeElement: null };
  globalThis.Element = FakeElement;
  globalThis.getComputedStyle = (node) => ({
    overflowY: node.attrs.overflow ?? "visible",
  });
  doc.body = new FakeElement("body");
  doc.activeElement = doc.body;
  const layer = new FakeElement(
    "div",
    { "data-layer": "home", overflow: "auto" },
    doc.body,
  );
  const tile = new FakeElement("button", {}, layer);
  const field = new FakeElement("input", {}, layer);
  const outside = new FakeElement("div", {}, doc.body);
  return { doc, layer, tile, field, outside };
}

test("readPullStart reads Home, editable content, the keyboard and scroll position", () => {
  const { doc, layer, tile, field, outside } = dom();
  const selectors = { home: '[data-layer="home"]' };
  try {
    assert.deepEqual(readPullStart(tile, selectors), empty);
    assert.equal(readPullStart(outside, selectors).home, false);
    assert.equal(readPullStart(field, selectors).editable, true);
    assert.equal(readPullStart(null, selectors), null);
    doc.activeElement = field;
    assert.equal(readPullStart(tile, selectors).keyboard, true);
    doc.activeElement = doc.body;
    layer.scrollTop = 20;
    layer.scrollHeight = 400;
    assert.equal(readPullStart(tile, selectors).scrolled, true);
  } finally {
    delete globalThis.Element;
    delete globalThis.getComputedStyle;
  }
});

test("installOverflowPull claims a downward drag at the top of an overflowing Home only", () => {
  const { doc, layer, tile } = dom();
  const listeners = new Map();
  doc.addEventListener = (type, listener) => listeners.set(type, listener);
  doc.removeEventListener = (type) => listeners.delete(type);
  layer.scrollHeight = 400;
  const touch = (target, x, y) => {
    let prevented = false;
    return {
      event: {
        target,
        cancelable: true,
        touches: [{ clientX: x, clientY: y }],
        preventDefault: () => {
          prevented = true;
        },
      },
      prevented: () => prevented,
    };
  };
  try {
    let eligible = true;
    const remove = installOverflowPull(
      () => eligible,
      { home: '[data-layer="home"]' },
      doc,
    );
    listeners.get("touchstart")(touch(tile, 100, 300).event);
    const down = touch(tile, 100, 320);
    listeners.get("touchmove")(down.event);
    assert.equal(down.prevented(), true, "a downward drag is claimed");
    listeners.get("touchend")();
    listeners.get("touchstart")(touch(tile, 100, 300).event);
    const up = touch(tile, 100, 280);
    listeners.get("touchmove")(up.event);
    assert.equal(up.prevented(), false, "an upward drag scrolls");
    eligible = false;
    listeners.get("touchstart")(touch(tile, 100, 300).event);
    const covered = touch(tile, 100, 340);
    listeners.get("touchmove")(covered.event);
    assert.equal(
      covered.prevented(),
      false,
      "nothing is claimed while Home is covered",
    );
    eligible = true;
    layer.scrollHeight = 100;
    listeners.get("touchstart")(touch(tile, 100, 300).event);
    const fits = touch(tile, 100, 340);
    listeners.get("touchmove")(fits.event);
    assert.equal(
      fits.prevented(),
      false,
      "a Home that fits leaves touch to pointer events",
    );
    remove();
    assert.equal(listeners.size, 0);
  } finally {
    delete globalThis.Element;
    delete globalThis.getComputedStyle;
  }
});
