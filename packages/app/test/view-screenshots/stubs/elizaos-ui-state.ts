/**
 * Stub for `@elizaos/ui/state` — the app-state store hook surface. The only
 * Calendar's source manager also reads the translation function. Keep this
 * tiny interpolating fallback aligned with the production selector contract.
 */

interface HarnessAppState {
  setActionNotice: (...args: unknown[]) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const HARNESS_STATE: HarnessAppState = {
  setActionNotice: () => {},
  t: (key, options) => {
    const template =
      typeof options?.defaultValue === "string" ? options.defaultValue : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(options?.[name] ?? ""),
    );
  },
};

export function useAppSelector<T>(selector: (state: HarnessAppState) => T): T {
  return selector(HARNESS_STATE);
}
