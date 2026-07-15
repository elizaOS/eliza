/**
 * Constructs browser audio primitives behind runtime validators so embedded
 * WebViews can expose vendor-prefixed or partial APIs without weakening the
 * typed voice pipeline.
 */

export type RuntimeValidator<T> = (value: unknown) => value is T;

function invokeCleanupBestEffort(value: unknown, methodName: string): void {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return;
  }
  try {
    const cleanup: unknown = Reflect.get(value, methodName);
    if (typeof cleanup !== "function") return;
    const result: unknown = Reflect.apply(cleanup, value, []);
    if (result && typeof Reflect.get(Object(result), "then") === "function") {
      void Promise.resolve(result).catch((ignoredError) => {
        // error-policy:J6 Rejected native cleanup must not mask validation.
        void ignoredError;
      });
    }
  } catch (ignoredError) {
    // error-policy:J6 Best-effort cleanup must not mask validation.
    void ignoredError;
  }
}

function browserAudioContextConstructor(): unknown {
  if (typeof window === "undefined") return undefined;
  return (
    Reflect.get(window, "AudioContext") ??
    Reflect.get(window, "webkitAudioContext")
  );
}

export function constructBrowserAudioContext<T>(
  args: readonly unknown[],
  validate: RuntimeValidator<T>,
): T | null {
  const ctor = browserAudioContextConstructor();
  if (typeof ctor !== "function") return null;
  const context: unknown = Reflect.construct(ctor, Array.from(args));
  if (validate(context)) return context;
  invokeCleanupBestEffort(context, "close");
  return null;
}

export function constructBrowserAudioWorkletNode<T>(
  context: object,
  name: string,
  validate: RuntimeValidator<T>,
): T | null {
  const ctor: unknown = globalThis.AudioWorkletNode;
  if (typeof ctor !== "function") return null;
  const node: unknown = Reflect.construct(ctor, [context, name]);
  if (validate(node)) return node;
  invokeCleanupBestEffort(node, "disconnect");
  return null;
}
