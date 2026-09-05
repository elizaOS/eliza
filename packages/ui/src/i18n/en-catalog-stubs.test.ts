/**
 * Guards the English catalog against key-derived stub values.
 *
 * `t()` resolves `localized[key] ?? english[key] ?? defaultValue`, so whatever
 * `en.json` holds is what English users see, and the call site's
 * `defaultValue` is only a fallback for an uncatalogued key. When the catalog
 * was backfilled, a number of keys received their own Title-Cased name as the
 * value — "Unsaved Changes Title", "Mode Line", "Conversation Count" — and
 * those strings shipped verbatim in English. This suite pins the corrected
 * entries through the real translator and scans every literal `t()` call site
 * so a new key cannot be catalogued as its own name again. Deterministic: real
 * catalog, real translator, tracked sources only.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTranslator } from "./index";
import en from "./locales/en.json" with { type: "json" };

const catalog = en as Record<string, string>;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** Catalog entries that used to be their own key name, with the text the call site intends. */
const CORRECTED_ENTRIES: ReadonlyArray<
  readonly [key: string, english: string]
> = [
  [
    "browserworkspace.FrameBlockedDescription",
    "This site doesn’t allow in-app viewing.",
  ],
  ["browserworkspace.FrameBlockedTitle", "Open this site in your browser"],
  [
    "browserworkspace.InternalTabUrlManaged",
    "This internal tab manages its own URL.",
  ],
  ["charactereditor.AddConversation", "Add conversation"],
  ["charactereditor.AddStyleRule", "Add style rule"],
  ["charactereditor.AddTurn", "Add turn"],
  ["charactereditor.ConversationCount", "conversations"],
  ["charactereditor.DontSave", "Don't save"],
  ["charactereditor.DragToReorder", "Drag to reorder"],
  ["charactereditor.PossibleDuplicates", "possible duplicates"],
  ["charactereditor.PostCount", "posts"],
  ["charactereditor.RemovePost", "Remove post"],
  [
    "charactereditor.ResetConfirmBody",
    "This will discard all unsaved changes and restore this character to its default values.",
  ],
  ["charactereditor.ResetToDefaults", "Reset to defaults?"],
  ["charactereditor.SwitchCharacterPrompt", "Switch to {{name}}?"],
  ["charactereditor.SwitchSectionPrompt", "Switch to {{name}}?"],
  [
    "charactereditor.UnsavedChangesBody",
    "You have unsaved changes. Save before switching?",
  ],
  ["charactereditor.UnsavedChangesTitle", "Unsaved changes"],
  ["cloud.mcps.testConnection", "Test connection"],
  [
    "computeruseapprovaloverlay.Body",
    "The agent requested local computer-use actions that need approval before they run.",
  ],
  ["computeruseapprovaloverlay.DenyReason", "Deny reason"],
  [
    "computeruseapprovaloverlay.DenyReasonPlaceholder",
    "Optional reason shown to the agent.",
  ],
  ["computeruseapprovaloverlay.ModeLine", "Approval mode: {{mode}}."],
  [
    "computeruseapprovaloverlay.ResolveFailed",
    "Failed to resolve computer-use approval.",
  ],
  ["computeruseapprovaloverlay.Resolving", "Resolving..."],
  ["computeruseapprovaloverlay.Title", "Review queued computer actions"],
  ["conversations.newTerminal", "New terminal"],
  ["filesview.moreActions", "More actions for {{name}}"],
  ["gameview.GameWindowNoLongerOpen", "Game window is no longer open."],
  [
    "gameview.NativeGameWindowNormal",
    "Native game window acts like a normal window.",
  ],
  ["gameview.NativeGameWindowPinned", "Native game window stays on top."],
  [
    "inboxview.AgentSendWarning",
    "This message will be sent as your agent in {{source}}.",
  ],
  ["settings.identity.previewVoice", "Preview voice"],
  ["settings.identity.saveFailed", "Failed to save identity settings."],
  ["settings.identity.stopVoicePreview", "Stop voice preview"],
  ["terminal.starting", "Starting terminal…"],
  ["trajectorydetailview.ProviderAccess", "Provider access"],
];

/**
 * Catalog values that equal their key name but are deliberate labels rather
 * than stubs. An entry here records that someone decided the key name IS the
 * intended English, and says why.
 */
const KEY_NAMED_LABEL_ALLOWLIST = new Map<string, string>([
  [
    "common.loading",
    "shared label; call sites disagree on a trailing ellipsis, so the catalog's plain form stands",
  ],
]);

const CALL_SITE =
  /\bt\(\s*"([a-zA-Z0-9_.-]+)"\s*,\s*\{[^}]*?defaultValue:\s*"((?:[^"\\]|\\.)*)"/gs;
const STRUCTURAL_SUFFIX =
  /(Title|Body|Prompt|Placeholder|Warning|Description|Line|Count|Failed|Managed|Normal|Pinned|NoLongerOpen)$/;

function humanizedKeyName(key: string): string {
  const segment = key.split(".").pop() ?? key;
  return segment.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function lettersOnly(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a catalog value is the key's own name standing in for real text. */
function isKeyNamedStub(
  key: string,
  catalogValue: string,
  callSiteDefault: string,
): boolean {
  if (catalogValue === callSiteDefault) return false;
  const keyName = humanizedKeyName(key);
  if (catalogValue.toLowerCase() !== keyName) return false;
  // A one-word label that differs from its call site only in case or
  // punctuation ("Open" / "Open ") is a label, not a stub; a multi-word one
  // ("Dont Save" / "Don't save") is the key name standing in for the text.
  if (
    keyName.includes(" ") &&
    lettersOnly(catalogValue) === lettersOnly(callSiteDefault)
  ) {
    return true;
  }
  return (
    /\{\{/.test(callSiteDefault) ||
    /[.?!…]$/.test(callSiteDefault) ||
    STRUCTURAL_SUFFIX.test(key.split(".").pop() ?? key)
  );
}

function trackedUiSources(): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--", "packages/ui/src/*.ts", "packages/ui/src/*.tsx"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter(
      (file) =>
        file && !/\.test\.tsx?$/.test(file) && !/\/locales\//.test(file),
    );
}

describe("English catalog entries that were their own key name", () => {
  const t = createTranslator("en");

  it.each(CORRECTED_ENTRIES)(
    "renders %s as the call site's text",
    (key, english) => {
      expect(catalog[key]).toBe(english);
      expect(
        t(key, { defaultValue: english, name: "x", mode: "auto", source: "y" }),
      ).toBe(
        english
          .replace("{{name}}", "x")
          .replace("{{mode}}", "auto")
          .replace("{{source}}", "y"),
      );
    },
  );

  it("catalogues no key as its own name where the call site supplies real text", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const file of trackedUiSources()) {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      for (const match of source.matchAll(CALL_SITE)) {
        const key = match[1];
        if (seen.has(key)) continue;
        const catalogValue = catalog[key];
        if (typeof catalogValue !== "string") continue;
        const callSiteDefault = JSON.parse(`"${match[2]}"`) as string;
        if (!isKeyNamedStub(key, catalogValue, callSiteDefault)) continue;
        seen.add(key);
        if (KEY_NAMED_LABEL_ALLOWLIST.has(key)) continue;
        offenders.push(
          `${key}: catalog "${catalogValue}" vs call site "${callSiteDefault}" (${file})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
