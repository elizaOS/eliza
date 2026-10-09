import { BillHostError } from "./errors.mjs";
export function validateBillControls(input) {
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "existingMethod,signIn,submit,verification"
  )
    throw new BillHostError("Invalid bill control configuration");
  const controls = structuredClone(input),
    labels = new Set();
  for (const [name, control] of Object.entries(controls)) {
    if (
      !control ||
      Object.keys(control).sort().join(",") !==
        (name === "existingMethod" ? "label,selector" : "label") ||
      (name === "existingMethod" &&
        (typeof control.selector !== "string" ||
          !/^#[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(control.selector))) ||
      typeof control.label !== "string" ||
      !control.label.trim() ||
      control.label !== control.label.trim() ||
      control.label.length > 120 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in provider and host data.
      /[\u0000-\u001f\u007f]/.test(control.label) ||
      labels.has(control.label)
    )
      throw new BillHostError(
        "Bill controls require one exact method ID and distinct labels",
      );
    labels.add(control.label);
    Object.freeze(control);
  }
  return Object.freeze(controls);
}
export function matchBillControl(snapshot, control) {
  // Snapshot selectors are opaque observation references. The native actuator
  // checks the selected reference against the configured CSS policy separately.
  const matches = snapshot.elements.filter(
    (element) => element.label === control.label,
  );
  return matches.length === 1 ? matches[0] : null;
}
