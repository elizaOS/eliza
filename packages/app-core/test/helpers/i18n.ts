import { type TranslationVars, t as translate } from "@elizaos/ui";

export function testT(key: string, vars?: TranslationVars): string {
  return translate("en", key, vars);
}
