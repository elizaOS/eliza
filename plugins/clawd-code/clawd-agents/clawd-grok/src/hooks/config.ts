import { loadUserSettings } from "../utils/settings.js";
import type { HookCommand, HookEvent, HookMatcher, HooksConfig } from "./types.js";

/**
 * Load hooks config from user settings (~/.clawd/user-settings.json) only.
 *
 * Project-level .clawd/settings.json hooks are intentionally excluded because
 * that file is repo-committed — a malicious repository could execute arbitrary
 * unsandboxed commands on a developer's machine via hook definitions.
 * Hooks run on the host (outside any sandbox) so they must be user-configured.
 */
export function loadHooksConfig(): HooksConfig {
  return loadUserSettings().hooks ?? {};
}

/**
 * Get hooks that match a given event and optional match value.
 *
 * For events that have a matcher field (e.g. PreToolUse matches on tool_name),
 * only matchers whose `matcher` string matches `matchValue` are included,
 * plus matchers with no `matcher` (which match everything).
 */
export function getMatchingHooks(config: HooksConfig, event: HookEvent, matchValue?: string): HookCommand[] {
  const matchers = config[event];
  if (!matchers || matchers.length === 0) return [];

  const matched: HookCommand[] = [];
  for (const entry of matchers) {
    if (matchesPattern(entry, matchValue)) {
      matched.push(...entry.hooks);
    }
  }

  return matched;
}

function matchesPattern(entry: HookMatcher, matchValue?: string): boolean {
  if (!entry.matcher) return true;
  if (!matchValue) return false;
  return matchValue === entry.matcher;
}
