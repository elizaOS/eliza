import assert from "node:assert/strict";
import test from "node:test";
import {
  editTextControl,
  isEditableTextControl,
} from "../../src/utils/text-control-editing.ts";

function realm() {
  class Event {
    constructor(type, options) {
      this.type = type;
      this.bubbles = options.bubbles;
    }
  }
  class Input {
    constructor(value = "") {
      this.raw = value;
      this.type = "text";
      this.isConnected = true;
      this.disabled = false;
      this.readOnly = false;
      this.maxLength = -1;
      this.selectionStart = this.selectionEnd = value.length;
      this.events = [];
      this.ownerDocument = { defaultView: view };
    }
    get value() {
      return this.raw;
    }
    set value(value) {
      this.raw = value;
    }
    dispatchEvent(event) {
      this.events.push(event);
    }
    setSelectionRange(start, end) {
      if (this.type === "email") throw new Error("Unsupported selection API");
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  }
  class Textarea extends Input {
    get value() {
      return this.raw;
    }
    set value(value) {
      this.raw = value;
    }
  }
  const view = {
    HTMLInputElement: Input,
    HTMLTextAreaElement: Textarea,
    Event,
  };
  return { Input, Textarea, Event };
}
test("host type policy and read-only/disabled fields control editability across realms", () => {
  const a = realm(),
    b = realm(),
    field = new b.Input();
  assert.equal(field instanceof a.Input, false);
  assert.equal(isEditableTextControl(field, ["text"]), true);
  field.type = "password";
  assert.equal(isEditableTextControl(field, ["text"]), false);
  assert.equal(isEditableTextControl(new b.Textarea(), []), true);
  for (const key of ["disabled", "readOnly"]) {
    field.type = "text";
    field[key] = true;
    assert.equal(isEditableTextControl(field, ["text"]), false);
    field[key] = false;
  }
  assert.equal(isEditableTextControl(null, ["text"]), false);
});
test("insertion replaces selection through native setter and emits a realm-owned bubbling event", () => {
  const { Input, Event } = realm(),
    field = new Input("Alex");
  Object.defineProperty(field, "value", {
    get() {
      return this.raw;
    },
    set() {
      throw new Error("controlled value tracker must be bypassed");
    },
  });
  field.selectionStart = 2;
  field.selectionEnd = 3;
  assert.equal(editTextControl(field, { kind: "insert", text: "a" }), true);
  assert.equal(field.value, "Alax");
  assert.equal(field.selectionStart, 3);
  assert.equal(field.selectionEnd, 3);
  assert.equal(field.events.length, 1);
  assert.equal(field.events[0].type, "input");
  assert.equal(field.events[0].bubbles, true);
  assert.ok(field.events[0] instanceof Event);
});
test("backspace deletes selections and complete surrogate pairs without dropping prior text", () => {
  const { Input } = realm(),
    field = new Input("a😀b");
  field.selectionStart = field.selectionEnd = 3;
  editTextControl(field, { kind: "backspace" });
  assert.equal(field.value, "ab");
  assert.equal(field.selectionStart, 1);
  field.selectionStart = 0;
  field.selectionEnd = 2;
  editTextControl(field, { kind: "backspace" });
  assert.equal(field.value, "");
  assert.equal(field.selectionStart, 0);
  editTextControl(field, { kind: "backspace" });
  assert.equal(field.value, "");
  assert.equal(field.selectionStart, 0);
});
test("maxLength rejects oversize edits without changing value, caret or dispatching", () => {
  const { Input } = realm(),
    field = new Input("ab");
  field.maxLength = 3;
  assert.equal(editTextControl(field, { kind: "insert", text: "😀" }), false);
  assert.equal(field.value, "ab");
  assert.equal(field.selectionStart, 2);
  assert.equal(field.events.length, 0);
  field.selectionStart = 0;
  field.selectionEnd = 2;
  assert.equal(editTextControl(field, { kind: "insert", text: "😀" }), true);
  assert.equal(field.value, "😀");
  assert.equal(field.selectionStart, 2);
});
test("backspace can repair an existing value longer than maxLength", () => {
  const { Input } = realm(),
    field = new Input("oversize");
  field.maxLength = 3;
  assert.equal(editTextControl(field, { kind: "backspace" }), true);
  assert.equal(field.value, "oversiz");
  assert.equal(field.selectionStart, 7);
  assert.equal(field.events.length, 1);
  assert.equal(editTextControl(field, { kind: "insert", text: "x" }), false);
  assert.equal(field.value, "oversiz");
});
test("textarea newlines and email fallback preserve editable text when selection API is absent", () => {
  const { Input, Textarea } = realm(),
    area = new Textarea("a");
  editTextControl(area, { kind: "insert", text: "\n" });
  assert.equal(area.value, "a\n");
  assert.equal(area.selectionStart, 2);
  const email = new Input("a@");
  email.type = "email";
  email.selectionStart = email.selectionEnd = null;
  assert.equal(
    editTextControl(email, { kind: "insert", text: "b.test" }),
    true,
  );
  assert.equal(email.value, "a@b.test");
  assert.equal(email.events.length, 1);
});
test("disconnected, unsupported, disabled and readonly controls never dispatch", () => {
  for (const patch of [
    { isConnected: false },
    { type: "number" },
    { disabled: true },
    { readOnly: true },
  ]) {
    const { Input } = realm(),
      field = Object.assign(new Input("same"), patch);
    assert.equal(editTextControl(field, { kind: "insert", text: "x" }), false);
    assert.equal(field.value, "same");
    assert.equal(field.events.length, 0);
  }
});
