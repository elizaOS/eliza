/** Owns android app actions using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import { patchAndroidAppActionsXmlResource } from "../android-manifest.mjs";
import { APP, androidDir, platformsDir } from "../context.mjs";
import { escapeRegExp, escapeXmlText } from "../escape.mjs";
import { assertSharedTreeOnlyForEliza } from "./shared-tree.mjs";

export function syncAndroidAppActionsResources() {
  assertSharedTreeOnlyForEliza("patch app-actions resources");
  const templateResDir = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "res",
  );
  const targetResDir = path.join(androidDir, "app", "src", "main", "res");
  const resourceFiles = [
    path.join("xml", "shortcuts.xml"),
    path.join("xml", "eliza_quick_actions_widget.xml"),
    path.join("xml", "eliza_accessibility_service.xml"),
    path.join("layout", "eliza_quick_actions_widget.xml"),
    path.join("drawable", "eliza_widget_background.xml"),
    path.join("drawable", "eliza_widget_button_background.xml"),
    path.join("xml", "method.xml"),
    path.join("xml", "eliza_voice_interaction_service.xml"),
    path.join("layout", "eliza_voice_ime.xml"),
    path.join("layout", "eliza_voice_interaction_bar.xml"),
    path.join("drawable", "ic_eliza_ime_keyboard.xml"),
    path.join("drawable", "ic_eliza_ime_mic.xml"),
    path.join("drawable", "ic_eliza_ime_open.xml"),
    path.join("drawable", "eliza_ime_mic_bg.xml"),
    path.join("drawable", "eliza_voice_bar_bg.xml"),
    path.join("drawable", "eliza_voice_bar_dot.xml"),
    path.join("values", "android_app_actions.xml"),
  ];
  for (const relPath of resourceFiles) {
    const templatePath = path.join(templateResDir, relPath);
    const targetPath = path.join(targetResDir, relPath);
    if (!fs.existsSync(templatePath)) continue;
    const templateContent = fs.readFileSync(templatePath);
    if (
      fs.existsSync(targetPath) &&
      fs.readFileSync(targetPath).equals(templateContent)
    ) {
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, templateContent);
    console.log(
      `[mobile-build] Synced Android App Actions resource ${relPath}.`,
    );
  }
  syncAndroidVoiceStringResources(templateResDir, targetResDir);

  // The staged App Actions drawables reference @color/eliza_orange, defined in
  // the eliza template's values/colors.xml. We don't copy colors.xml wholesale
  // (a white-label target keeps its own brand colors), so stage just the
  // referenced color into a dedicated file — and ONLY when the target doesn't
  // already define it, so the eliza tree (whose colors.xml already has it)
  // avoids a duplicate-resource merge error.
  const templateColorsXml = path.join(templateResDir, "values", "colors.xml");
  const elizaOrangeMatch = fs.existsSync(templateColorsXml)
    ? fs
        .readFileSync(templateColorsXml, "utf8")
        .match(/<color name="eliza_orange">([^<]+)<\/color>/)
    : null;
  if (elizaOrangeMatch) {
    const alreadyDefined = ["colors.xml", "eliza_app_actions_colors.xml"].some(
      (name) => {
        const p = path.join(targetResDir, "values", name);
        return (
          fs.existsSync(p) &&
          /name="eliza_orange"/.test(fs.readFileSync(p, "utf8"))
        );
      },
    );
    if (!alreadyDefined) {
      const colorFile = path.join(
        targetResDir,
        "values",
        "eliza_app_actions_colors.xml",
      );
      fs.mkdirSync(path.dirname(colorFile), { recursive: true });
      fs.writeFileSync(
        colorFile,
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="eliza_orange">${elizaOrangeMatch[1]}</color>\n</resources>\n`,
      );
      console.log(
        "[mobile-build] Staged @color/eliza_orange for App Actions widget (white-label target).",
      );
    }
  }

  const shortcutsPath = path.join(targetResDir, "xml", "shortcuts.xml");
  if (!fs.existsSync(shortcutsPath)) return;

  const current = fs.readFileSync(shortcutsPath, "utf8");
  const patched = patchAndroidAppActionsXmlResource(current, {
    androidPackage: APP.appId,
    urlScheme: APP.urlScheme,
  });
  if (patched !== current) {
    fs.writeFileSync(shortcutsPath, patched, "utf8");
    console.log(
      "[mobile-build] Rewrote Android App Actions package and scheme.",
    );
  }
}

export function syncAndroidVoiceStringResources(templateResDir, targetResDir) {
  const templateStringsPath = path.join(
    templateResDir,
    "values",
    "strings.xml",
  );
  const targetStringsPath = path.join(targetResDir, "values", "strings.xml");
  if (
    !fs.existsSync(templateStringsPath) ||
    !fs.existsSync(targetStringsPath)
  ) {
    return;
  }

  const voiceStringNames = [
    "assistant_session_prompt",
    "eliza_ime_label",
    "eliza_ime_subtype_voice",
    "eliza_ime_prompt",
    "eliza_ime_listening",
    "eliza_ime_transcribing",
    "eliza_ime_no_speech",
    "eliza_ime_hint",
    "eliza_ime_switch_back",
    "eliza_ime_engine_off",
    "eliza_ime_model_not_ready",
    "eliza_ime_permission_needed",
    "eliza_ime_error_mic",
    "eliza_ime_error_transcribe",
  ];
  const template = fs.readFileSync(templateStringsPath, "utf8");
  let target = fs.readFileSync(targetStringsPath, "utf8");
  const missing = [];
  for (const name of voiceStringNames) {
    const hasString = new RegExp(
      `<string\\s+name="${escapeRegExp(name)}"`,
    ).test(target);
    if (hasString) continue;
    const match = template.match(
      new RegExp(
        `<string\\s+name="${escapeRegExp(name)}"[^>]*>[\\s\\S]*?<\\/string>`,
      ),
    );
    if (!match) continue;
    missing.push(match[0].replace(/\bEliza\b/g, escapeXmlText(APP.appName)));
  }
  if (missing.length === 0) return;

  target = target.replace(
    /\s*<\/resources>\s*$/,
    `\n    <!-- Native voice assistant and voice-input resources. -->\n    ${missing.join("\n    ")}\n</resources>\n`,
  );
  fs.writeFileSync(targetStringsPath, target, "utf8");
  console.log(
    `[mobile-build] Added Android voice string resources (${missing.length}).`,
  );
}
