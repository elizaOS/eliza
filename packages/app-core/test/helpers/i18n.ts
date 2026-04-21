import { type TranslationVars, t as translate } from "../../src/i18n";

export function testT(key: string, vars?: TranslationVars): string {
  return translate("en", key, vars);
}
