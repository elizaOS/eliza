/**
 * Browser stand-ins for the app-state singletons the transcript deep-link
 * `__e2e__` fixture bundle replaces (#14806): a minimal `useAppSelector`
 * app-value (identity `t` with `{{var}}` interpolation + a console-logging
 * `setActionNotice`), and a `useRegisterViewChatBinding` that parks the live
 * binding on `window.__viewChatBinding` so the runner can feed search queries
 * exactly the way the floating composer does. Everything under DocumentsView
 * renders real; only these host singletons are faked.
 */

function translate(
  key: string,
  options?: { defaultValue?: string } & Record<string, unknown>,
): string {
  const template = options?.defaultValue ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    options && name in options ? String(options[name]) : `{{${name}}}`,
  );
}

const appValue: Record<string, unknown> = {
  t: translate,
  setActionNotice: (...args: unknown[]) => {
    console.log("[action-notice]", ...args);
  },
};

type Selector = (value: Record<string, unknown>) => unknown;

export const useApp = () => appValue;
export const useAppSelector = (selector: Selector) => selector(appValue);
export const useAppSelectorShallow = (selector: Selector) =>
  selector(appValue);
export const useTranslation = () => ({ t: translate });

declare global {
  interface Window {
    __viewChatBinding?: { onQuery?: (value: string) => void };
  }
}

export function useRegisterViewChatBinding(binding: {
  onQuery?: (value: string) => void;
}): void {
  window.__viewChatBinding = binding;
}

export const confirmDesktopAction = async () => true;
