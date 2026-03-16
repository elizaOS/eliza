import fs from "node:fs";
import path from "node:path";
import {
  createTranslator,
  MESSAGES,
  normalizeLanguage,
  t,
  UI_LANGUAGES,
} from "@elizaos/app-core/i18n";
import { describe, expect, it } from "vitest";

describe("i18n helpers", () => {
  it("normalizes supported language tags", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeLanguage("zh")).toBe("zh-CN");
    expect(normalizeLanguage("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLanguage("en-US")).toBe("en");
  });

  it("falls back to english for unknown language input", () => {
    expect(normalizeLanguage("xx")).toBe("en");
    expect(normalizeLanguage(undefined)).toBe("en");
  });

  it("falls back to english message when key is missing in selected locale", () => {
    expect(t("zh-CN", "nav.chat")).toBe("聊天");
    expect(t("zh-CN", "nonexistent.key")).toBe("nonexistent.key");
  });

  it("uses defaultValue when a translation key is missing everywhere", () => {
    expect(
      t("pt", "settings.missingExample", { defaultValue: "Fallback copy" }),
    ).toBe("Fallback copy");
  });

  it("interpolates template variables", () => {
    expect(t("en", "pairing.expiresIn", { seconds: 12 })).toContain("12");
    expect(t("zh-CN", "conversations.minutesAgo", { count: 8 })).toContain("8");
  });

  it("creates stable translator for a target language", () => {
    const zh = createTranslator("zh-CN");
    expect(zh("nav.wallets")).toBe("钱包");
  });

  it("keeps the image processing upload label short in every locale", () => {
    expect(MESSAGES.en["knowledgeview.IncludeAIImageDes"]).toBe(
      "Process Images",
    );
    expect(MESSAGES.es["knowledgeview.IncludeAIImageDes"]).toBe(
      "Procesar imágenes",
    );
    expect(MESSAGES.ko["knowledgeview.IncludeAIImageDes"]).toBe("이미지 처리");
    expect(MESSAGES.pt["knowledgeview.IncludeAIImageDes"]).toBe(
      "Processar imagens",
    );
    expect(MESSAGES["zh-CN"]["knowledgeview.IncludeAIImageDes"]).toBe(
      "处理图片",
    );
  });

  it("keeps locale keys in sync across all supported locales", () => {
    const collectKeys = (obj: Record<string, string>): string[] => {
      return Object.keys(obj);
    };

    const enKeys = new Set(collectKeys(MESSAGES.en));
    for (const language of UI_LANGUAGES) {
      const localeKeys = new Set(collectKeys(MESSAGES[language]));
      const missingInLocale: string[] = [];
      const missingInEnglish: string[] = [];

      enKeys.forEach((key) => {
        if (!localeKeys.has(key)) {
          missingInLocale.push(key);
        }
      });

      localeKeys.forEach((key) => {
        if (!enKeys.has(key)) {
          missingInEnglish.push(key);
        }
      });

      expect(missingInLocale, `missing keys in ${language}`).toEqual([]);
      expect(missingInEnglish, `unexpected keys in ${language}`).toEqual([]);
    }
  });

  it("keeps production UI source files free of hardcoded Chinese text", () => {
    const candidates = [
      path.resolve(process.cwd(), "src"),
      path.resolve(process.cwd(), "apps", "app", "src"),
      path.resolve(__dirname, "..", "src"),
    ];
    const sourceDir =
      candidates.find((candidate) => fs.existsSync(candidate)) ??
      path.resolve(process.cwd(), "src");
    const exclusions = [
      path.join(sourceDir, "i18n", "messages.ts"),
      path.join(sourceDir, "onboarding-presets.ts"),
    ];

    const hasChinese = /[\u4e00-\u9fff]/;
    const filesWithChinese: string[] = [];

    const visit = (dir: string) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const itemPath = path.join(dir, item.name);

        if (item.isDirectory()) {
          if (item.name === "test" || item.name.startsWith(".")) {
            continue;
          }
          visit(itemPath);
          continue;
        }

        if (!item.isFile()) {
          continue;
        }

        if (!/\.(ts|tsx|js|jsx)$/.test(item.name)) {
          continue;
        }

        if (item.name.endsWith(".test.ts") || item.name.endsWith(".test.tsx")) {
          continue;
        }

        if (exclusions.includes(itemPath)) {
          continue;
        }

        const content = fs.readFileSync(itemPath, "utf8");
        if (hasChinese.test(content)) {
          const lines = content.split("\n");
          const lineIndex = lines.findIndex((line) => hasChinese.test(line));
          const snippet = lines[lineIndex]?.trim() ?? "";
          const relative = path.relative(process.cwd(), itemPath);
          filesWithChinese.push(`${relative}: L${lineIndex + 1}: ${snippet}`);
        }
      }
    };

    visit(sourceDir);

    expect(filesWithChinese).toEqual([]);
  });
});
