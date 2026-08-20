/** Decides whether desktop startup may activate the macOS-wide Fn-key monitor. */

export function shouldStartFnHoldMonitor(options: {
  cloudOnly: boolean;
}): boolean {
  return !options.cloudOnly;
}
