/** Verifies the durable, one-shot post-auth greeting handoff. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCloudAuthFirstScreenGreeting,
  consumeCloudAuthFirstScreenGreeting,
  markCloudAuthFirstScreenGreeting,
} from "./cloud-auth-first-screen";

describe("Cloud auth-first greeting handoff", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          removeItem: (key: string) => values.delete(key),
          setItem: (key: string, value: string) => values.set(key, value),
        },
      },
    });
  });
  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("survives navigation and is consumed exactly once", () => {
    markCloudAuthFirstScreenGreeting();
    expect(consumeCloudAuthFirstScreenGreeting()).toBe(true);
    expect(consumeCloudAuthFirstScreenGreeting()).toBe(false);
  });

  it("does not greet after a failed login", () => {
    markCloudAuthFirstScreenGreeting();
    clearCloudAuthFirstScreenGreeting();
    expect(consumeCloudAuthFirstScreenGreeting()).toBe(false);
  });
});
