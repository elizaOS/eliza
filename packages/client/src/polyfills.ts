// Minimal, robust browser shims for Node globals that some deps expect
import { Buffer } from 'buffer';

// Ensure globalThis is used as the single global
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g: any =
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : // @ts-ignore
        typeof global !== 'undefined'
        ? global
        : {};

if (!g.Buffer) {
  g.Buffer = Buffer;
}

if (!g.global) {
  g.global = g;
}

if (!g.process) {
  g.process = {
    env: {},
    browser: true,
    version: '',
    versions: {},
    nextTick: (cb: (...args: any[]) => void) =>
      Promise.resolve()
        .then(cb)
        .catch(() => setTimeout(cb, 0)),
  };
}

export {};
