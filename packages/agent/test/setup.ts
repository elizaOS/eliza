import { afterAll, afterEach, vi } from "vitest";

// Ensure Vitest environment is properly set
process.env.VITEST = "true";
// Keep test output focused on failures; individual tests can override.
process.env.LOG_LEVEL ??= "error";

declare global {
  // React 18 testing flag to suppress act() environment warnings.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error.bind(console);

function shouldIgnoreConsoleError(args: unknown[]): boolean {
  const first = args[0];
  if (typeof first !== "string") return false;
  return (
    first.includes("react-test-renderer is deprecated") ||
    first.includes(
      "The current testing environment is not configured to support act(...)",
    )
  );
}

console.error = (...args: unknown[]) => {
  if (shouldIgnoreConsoleError(args)) return;
  originalConsoleError(...args);
};

if (typeof globalThis.HTMLCanvasElement !== "undefined") {
  const createCanvas2DContext = () =>
    ({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      })),
      putImageData: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      rect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      transform: vi.fn(),
      setTransform: vi.fn(),
      resetTransform: vi.fn(),
      fillText: vi.fn(),
      strokeText: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createPattern: vi.fn(() => null),
      canvas: document.createElement("canvas"),
      lineWidth: 1,
      globalAlpha: 1,
      fillStyle: "#000",
      strokeStyle: "#000",
    }) satisfies Partial<CanvasRenderingContext2D>;

  Object.defineProperty(globalThis.HTMLCanvasElement.prototype, "getContext", {
    value: vi.fn((contextType: string) =>
      contextType === "2d" ? createCanvas2DContext() : null,
    ),
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis.HTMLCanvasElement.prototype, "toDataURL", {
    value: vi.fn(() => "data:image/png;base64,dGVzdA=="),
    writable: true,
    configurable: true,
  });
}

import { withIsolatedTestHome } from "./test-env";

const testEnv = withIsolatedTestHome();
afterAll(() => testEnv.cleanup());

afterAll(() => {
  // Some integration-style tests can leave chokidar/fs watchers open in workers,
  // which keeps Vitest from exiting cleanly on local runs.
  const getActiveHandles = (
    process as NodeJS.Process & {
      _getActiveHandles?: () => unknown[];
    }
  )._getActiveHandles;
  const handles = getActiveHandles?.() ?? [];
  for (const handle of handles) {
    if (!handle || typeof handle !== "object") continue;
    const name = (handle as { constructor?: { name?: string } }).constructor
      ?.name;
    if (name !== "FSWatcher" && name !== "FSEvent" && name !== "StatWatcher") {
      continue;
    }
    try {
      (handle as { close?: () => void }).close?.();
    } catch {
      // Best-effort cleanup only.
    }
  }
});

afterEach(() => {
  // Guard against leaked fake timers across test files/workers.
  vi.useRealTimers();
});
