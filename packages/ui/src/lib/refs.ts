import type * as React from "react";

export function assignRef<T>(
  ref: React.Ref<T> | undefined,
  value: T | null,
): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}
