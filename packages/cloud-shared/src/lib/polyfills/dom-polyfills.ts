/**
 * Polyfills for browser-only DOM APIs that some packages (like pdfjs-dist) expect
 * This ensures these packages can be loaded in Node.js/Next.js server environment
 */

// Only apply polyfills on server-side (Node.js environment)
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  // Polyfill DOMMatrix if it doesn't exist
  if (typeof globalThis.DOMMatrix === "undefined") {
    // Minimal DOMMatrix polyfill - just enough to prevent import errors
    // pdfjs-dist checks for DOMMatrix existence but may not use it server-side
    (globalThis as Record<string, unknown>).DOMMatrix = class DOMMatrix {
      m11 = 1;
      m12 = 0;
      m13 = 0;
      m14 = 0;
      m21 = 0;
      m22 = 1;
      m23 = 0;
      m24 = 0;
      m31 = 0;
      m32 = 0;
      m33 = 1;
      m34 = 0;
      m41 = 0;
      m42 = 0;
      m43 = 0;
      m44 = 1;

      constructor(init?: string | number[]) {
        // Minimal constructor - just prevent errors
        if (Array.isArray(init)) {
          if (init.length >= 6) {
            this.m11 = init[0];
            this.m12 = init[1];
            this.m21 = init[2];
            this.m22 = init[3];
            this.m41 = init[4];
            this.m42 = init[5];
          }
        }
      }

      translate(tx: number, ty: number) {
        return this;
      }

      scale(sx: number, sy?: number) {
        return this;
      }

      rotate(angle: number) {
        return this;
      }
    };
  }

  // Polyfill Path2D if needed
  if (typeof globalThis.Path2D === "undefined") {
    (globalThis as Record<string, unknown>).Path2D = class Path2D {
      constructor(_path?: string | Path2D) {}
      addPath(_path: Path2D) {}
      closePath() {}
      moveTo(x: number, y: number) {}
      lineTo(x: number, y: number) {}
      bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) {}
      quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {}
      arc(
        x: number,
        y: number,
        radius: number,
        startAngle: number,
        endAngle: number,
        anticlockwise?: boolean,
      ) {}
      ellipse(
        x: number,
        y: number,
        radiusX: number,
        radiusY: number,
        rotation: number,
        startAngle: number,
        endAngle: number,
        anticlockwise?: boolean,
      ) {}
      rect(x: number, y: number, w: number, h: number) {}
    };
  }

  // Polyfill OffscreenCanvas if needed
  if (typeof globalThis.OffscreenCanvas === "undefined") {
    (globalThis as Record<string, unknown>).OffscreenCanvas = class OffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext(contextType: string) {
        return null;
      }

      convertToBlob() {
        return Promise.resolve(new Blob());
      }
    };
  }
}

// Export a no-op function so this can be imported
export function initPolyfills() {
  // Polyfills are applied on module load
}
