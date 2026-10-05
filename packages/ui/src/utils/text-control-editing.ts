export type TextControl = HTMLInputElement | HTMLTextAreaElement;
export type TextControlEdit =
  | { kind: "insert"; text: string }
  | { kind: "backspace" };

/** Hosts choose which input types may summon their keyboard. */
export function isEditableTextControl(
  target: EventTarget | null,
  allowedInputTypes: readonly string[],
): target is TextControl {
  const view = (target as HTMLElement | null)?.ownerDocument?.defaultView;
  return (
    !!view &&
    (target instanceof view.HTMLTextAreaElement ||
      (target instanceof view.HTMLInputElement &&
        allowedInputTypes.includes(target.type))) &&
    !target.disabled &&
    !target.readOnly
  );
}

/** Apply a text edit through the realm's native value setter so controlled
 * renderers observe the input event. Key mapping, focus and visibility stay with
 * the host. Backspace removes the last code point before the selection;
 * selection offsets and maxLength use the platform's UTF-16 unit convention. */
export function editTextControl(
  field: TextControl,
  edit: TextControlEdit,
): boolean {
  if (
    !field.isConnected ||
    !isEditableTextControl(field, [
      "text",
      "search",
      "email",
      "tel",
      "url",
      "password",
    ])
  )
    return false;
  const view = field.ownerDocument.defaultView;
  if (!view) return false;
  const value = field.value;
  let start = field.selectionStart ?? value.length;
  const end = field.selectionEnd ?? value.length;
  const text = edit.kind === "backspace" ? "" : edit.text;
  if (edit.kind === "backspace" && start === end)
    start -= Array.from(value.slice(0, start)).at(-1)?.length ?? 0;
  const next = value.slice(0, start) + text + value.slice(end);
  if (
    edit.kind === "insert" &&
    field.maxLength >= 0 &&
    next.length > field.maxLength
  )
    return false;
  const prototype =
    field instanceof view.HTMLTextAreaElement
      ? view.HTMLTextAreaElement.prototype
      : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new TypeError("Text control value setter is unavailable");
  setter.call(field, next);
  field.dispatchEvent(new view.Event("input", { bubbles: true }));
  try {
    field.setSelectionRange(start + text.length, start + text.length);
  } catch {
    /* Email controls do not expose selection ranges. */
  }
  return true;
}
