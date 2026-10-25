/**
 * Test helper that runs requestAnimationFrame callbacks synchronously, so
 * raf-driven UI settles deterministically under vitest.
 */
import { vi } from "vitest";

export function runAnimationFramesImmediately(): void {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(performance.now());
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
}
