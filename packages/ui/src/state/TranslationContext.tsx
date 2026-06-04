/**
 * Compatibility re-export. The i18n context object + `useTranslation` hook live
 * in `./TranslationContext.hooks`; the `TranslationProvider` component lives in
 * `./TranslationProvider` — each split so they stay React Fast
 * Refresh-compatible. This module keeps the `state` / root barrels resolving
 * unchanged.
 */
export {
  type TranslationContextValue,
  useTranslation,
} from "./TranslationContext.hooks";
export { TranslationProvider } from "./TranslationProvider";
