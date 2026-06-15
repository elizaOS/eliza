// Stub for `node:util` in the Storybook browser catalog. promisify is used at
// load by core modules pulled via the @elizaos/shared barrel; provide a working
// implementation plus benign shims for the rest.
// biome-ignore lint/suspicious/noExplicitAny: thin node:util shim
type AnyFn = (...args: any[]) => any;

export const promisify =
  (fn: AnyFn) =>
  (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      fn(...args, (err: unknown, ...rest: unknown[]) =>
        err ? reject(err) : resolve(rest.length > 1 ? rest : rest[0]),
      );
    });

export const callbackify =
  (fn: AnyFn) =>
  (...args: unknown[]) => {
    const cb = args.pop() as (err: unknown, val?: unknown) => void;
    Promise.resolve(fn(...args)).then(
      (v) => cb(null, v),
      (e) => cb(e),
    );
  };

export const inherits = (
  ctor: { prototype: object; super_?: unknown },
  superCtor: { prototype: object },
) => {
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
};

export const inspect = (value: unknown) => {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const format = (...args: unknown[]) =>
  args.map((a) => inspect(a)).join(" ");
export const deprecate = <T extends AnyFn>(fn: T): T => fn;
export const isDeepStrictEqual = (a: unknown, b: unknown) => a === b;
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export const types = {
  isDate: (v: unknown) => v instanceof Date,
  isRegExp: (v: unknown) => v instanceof RegExp,
  isNativeError: (v: unknown) => v instanceof Error,
};

export default {
  promisify,
  callbackify,
  inherits,
  inspect,
  format,
  deprecate,
  isDeepStrictEqual,
  TextEncoder,
  TextDecoder,
  types,
};
