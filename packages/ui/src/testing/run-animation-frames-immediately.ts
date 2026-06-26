import { vi } from "vitest";

export function runAnimationFramesImmediately(): void {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(performance.now());
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
}
