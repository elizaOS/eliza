/**
 * `MultilingualPromptRegistry` — registry for localized `ActionExample`
 * pairs and short prompt fragments referenced by `exampleKey`.
 *
 * Background (per `IMPLEMENTATION_PLAN.md` §5.5 and `GAP_ASSESSMENT.md`
 * §3.7): action examples and routing hints live as registered translation
 * tables, not as `ActionExample` literals embedded in source. The user's
 * locale is read from `OwnerFactStore.locale`; the planner can ask the
 * registry for a localized example when surfacing the prompt to the LLM.
 *
 * The registry's only persistent state is in-memory; the default pack is
 * loaded by `registerDefaultPromptPack`. The registry is registered onto
 * the runtime so other actions / providers can resolve example pairs by
 * key without owning the table themselves.
 */

import type { ActionExample, IAgentRuntime } from "@elizaos/core";
import { app_block_es_examples } from "./generated/app-block.es.js";
import { app_block_fr_examples } from "./generated/app-block.fr.js";
import { app_block_ja_examples } from "./generated/app-block.ja.js";
import { skill_es_examples } from "./generated/as-skill.es.js";
import { skill_fr_examples } from "./generated/as-skill.fr.js";
import { skill_ja_examples } from "./generated/as-skill.ja.js";
import { use_skill_es_examples } from "./generated/as-use-skill.es.js";
import { use_skill_fr_examples } from "./generated/as-use-skill.fr.js";
import { use_skill_ja_examples } from "./generated/as-use-skill.ja.js";
import { autofill_es_examples } from "./generated/autofill.es.js";
import { autofill_fr_examples } from "./generated/autofill.fr.js";
import { autofill_ja_examples } from "./generated/autofill.ja.js";
import { block_es_examples } from "./generated/block.es.js";
import { block_fr_examples } from "./generated/block.fr.js";
import { block_ja_examples } from "./generated/block.ja.js";
import { book_travel_es_examples } from "./generated/book-travel.es.js";
import { book_travel_fr_examples } from "./generated/book-travel.fr.js";
import { book_travel_ja_examples } from "./generated/book-travel.ja.js";
import { manage_browser_bridge_es_examples } from "./generated/browser-manage-bridge.es.js";
import { manage_browser_bridge_fr_examples } from "./generated/browser-manage-bridge.fr.js";
import { manage_browser_bridge_ja_examples } from "./generated/browser-manage-bridge.ja.js";
import { calendar_es_examples } from "./generated/calendar.es.js";
import { calendar_fr_examples } from "./generated/calendar.fr.js";
import { calendar_ja_examples } from "./generated/calendar.ja.js";
import { checkin_es_examples } from "./generated/checkin.es.js";
import { checkin_fr_examples } from "./generated/checkin.fr.js";
import { checkin_ja_examples } from "./generated/checkin.ja.js";
import { connector_es_examples } from "./generated/connector.es.js";
import { connector_fr_examples } from "./generated/connector.fr.js";
import { connector_ja_examples } from "./generated/connector.ja.js";
import { credentials_es_examples } from "./generated/credentials.es.js";
import { credentials_fr_examples } from "./generated/credentials.fr.js";
import { credentials_ja_examples } from "./generated/credentials.ja.js";
import { ask_user_question_es_examples } from "./generated/ct-ask-user-question.es.js";
import { ask_user_question_fr_examples } from "./generated/ct-ask-user-question.fr.js";
import { ask_user_question_ja_examples } from "./generated/ct-ask-user-question.ja.js";
import { bash_es_examples } from "./generated/ct-bash.es.js";
import { bash_fr_examples } from "./generated/ct-bash.fr.js";
import { bash_ja_examples } from "./generated/ct-bash.ja.js";
import { edit_es_examples } from "./generated/ct-edit.es.js";
import { edit_fr_examples } from "./generated/ct-edit.fr.js";
import { edit_ja_examples } from "./generated/ct-edit.ja.js";
import { enter_worktree_es_examples } from "./generated/ct-enter-worktree.es.js";
import { enter_worktree_fr_examples } from "./generated/ct-enter-worktree.fr.js";
import { enter_worktree_ja_examples } from "./generated/ct-enter-worktree.ja.js";
import { exit_worktree_es_examples } from "./generated/ct-exit-worktree.es.js";
import { exit_worktree_fr_examples } from "./generated/ct-exit-worktree.fr.js";
import { exit_worktree_ja_examples } from "./generated/ct-exit-worktree.ja.js";
import { glob_es_examples } from "./generated/ct-glob.es.js";
import { glob_fr_examples } from "./generated/ct-glob.fr.js";
import { glob_ja_examples } from "./generated/ct-glob.ja.js";
import { grep_es_examples } from "./generated/ct-grep.es.js";
import { grep_fr_examples } from "./generated/ct-grep.fr.js";
import { grep_ja_examples } from "./generated/ct-grep.ja.js";
import { ls_es_examples } from "./generated/ct-ls.es.js";
import { ls_fr_examples } from "./generated/ct-ls.fr.js";
import { ls_ja_examples } from "./generated/ct-ls.ja.js";
import { read_es_examples } from "./generated/ct-read.es.js";
import { read_fr_examples } from "./generated/ct-read.fr.js";
import { read_ja_examples } from "./generated/ct-read.ja.js";
import { web_fetch_es_examples } from "./generated/ct-web-fetch.es.js";
import { web_fetch_fr_examples } from "./generated/ct-web-fetch.fr.js";
import { web_fetch_ja_examples } from "./generated/ct-web-fetch.ja.js";
import { write_es_examples } from "./generated/ct-write.es.js";
import { write_fr_examples } from "./generated/ct-write.fr.js";
import { write_ja_examples } from "./generated/ct-write.ja.js";
import { desktop_es_examples } from "./generated/cu-desktop.es.js";
import { desktop_fr_examples } from "./generated/cu-desktop.fr.js";
import { desktop_ja_examples } from "./generated/cu-desktop.ja.js";
import { computer_use_es_examples } from "./generated/cu-use-computer.es.js";
import { computer_use_fr_examples } from "./generated/cu-use-computer.fr.js";
import { computer_use_ja_examples } from "./generated/cu-use-computer.ja.js";
import { device_intent_es_examples } from "./generated/device-intent.es.js";
import { device_intent_fr_examples } from "./generated/device-intent.fr.js";
import { device_intent_ja_examples } from "./generated/device-intent.ja.js";
import { entity_es_examples } from "./generated/entity.es.js";
import { entity_fr_examples } from "./generated/entity.fr.js";
import { entity_ja_examples } from "./generated/entity.ja.js";
import { first_run_es_examples } from "./generated/first-run.es.js";
import { first_run_fr_examples } from "./generated/first-run.fr.js";
import { first_run_ja_examples } from "./generated/first-run.ja.js";
import { health_es_examples } from "./generated/health.es.js";
import { health_fr_examples } from "./generated/health.fr.js";
import { health_ja_examples } from "./generated/health.ja.js";
import { life_es_examples } from "./generated/life.es.js";
import { life_fr_examples } from "./generated/life.fr.js";
import { life_ja_examples } from "./generated/life.ja.js";
import { lifeops_es_examples } from "./generated/lifeops-pause.es.js";
import { lifeops_fr_examples } from "./generated/lifeops-pause.fr.js";
import { lifeops_ja_examples } from "./generated/lifeops-pause.ja.js";
import { clear_linear_activity_es_examples } from "./generated/linear-clear-activity.es.js";
import { clear_linear_activity_fr_examples } from "./generated/linear-clear-activity.fr.js";
import { clear_linear_activity_ja_examples } from "./generated/linear-clear-activity.ja.js";
import { create_linear_comment_es_examples } from "./generated/linear-create-comment.es.js";
import { create_linear_comment_fr_examples } from "./generated/linear-create-comment.fr.js";
import { create_linear_comment_ja_examples } from "./generated/linear-create-comment.ja.js";
import { create_linear_issue_es_examples } from "./generated/linear-create-issue.es.js";
import { create_linear_issue_fr_examples } from "./generated/linear-create-issue.fr.js";
import { create_linear_issue_ja_examples } from "./generated/linear-create-issue.ja.js";
import { delete_linear_comment_es_examples } from "./generated/linear-delete-comment.es.js";
import { delete_linear_comment_fr_examples } from "./generated/linear-delete-comment.fr.js";
import { delete_linear_comment_ja_examples } from "./generated/linear-delete-comment.ja.js";
import { delete_linear_issue_es_examples } from "./generated/linear-delete-issue.es.js";
import { delete_linear_issue_fr_examples } from "./generated/linear-delete-issue.fr.js";
import { delete_linear_issue_ja_examples } from "./generated/linear-delete-issue.ja.js";
import { get_linear_activity_es_examples } from "./generated/linear-get-activity.es.js";
import { get_linear_activity_fr_examples } from "./generated/linear-get-activity.fr.js";
import { get_linear_activity_ja_examples } from "./generated/linear-get-activity.ja.js";
import { get_linear_issue_es_examples } from "./generated/linear-get-issue.es.js";
import { get_linear_issue_fr_examples } from "./generated/linear-get-issue.fr.js";
import { get_linear_issue_ja_examples } from "./generated/linear-get-issue.ja.js";
import { linear_es_examples } from "./generated/linear-linear.es.js";
import { linear_fr_examples } from "./generated/linear-linear.fr.js";
import { linear_ja_examples } from "./generated/linear-linear.ja.js";
import { list_linear_comments_es_examples } from "./generated/linear-list-comments.es.js";
import { list_linear_comments_fr_examples } from "./generated/linear-list-comments.fr.js";
import { list_linear_comments_ja_examples } from "./generated/linear-list-comments.ja.js";
import { search_linear_issues_es_examples } from "./generated/linear-search-issues.es.js";
import { search_linear_issues_fr_examples } from "./generated/linear-search-issues.fr.js";
import { search_linear_issues_ja_examples } from "./generated/linear-search-issues.ja.js";
import { update_linear_issue_es_examples } from "./generated/linear-update-issue.es.js";
import { update_linear_issue_fr_examples } from "./generated/linear-update-issue.fr.js";
import { update_linear_issue_ja_examples } from "./generated/linear-update-issue.ja.js";
import { message_handoff_es_examples } from "./generated/message-handoff.es.js";
import { message_handoff_fr_examples } from "./generated/message-handoff.fr.js";
import { message_handoff_ja_examples } from "./generated/message-handoff.ja.js";
import { money_es_examples } from "./generated/money.es.js";
import { money_fr_examples } from "./generated/money.fr.js";
import { money_ja_examples } from "./generated/money.ja.js";
import { manage_routing_es_examples } from "./generated/music-manage-routing.es.js";
import { manage_routing_fr_examples } from "./generated/music-manage-routing.fr.js";
import { manage_routing_ja_examples } from "./generated/music-manage-routing.ja.js";
import { manage_zones_es_examples } from "./generated/music-manage-zones.es.js";
import { manage_zones_fr_examples } from "./generated/music-manage-zones.fr.js";
import { manage_zones_ja_examples } from "./generated/music-manage-zones.ja.js";
import { music_library_es_examples } from "./generated/music-music-library.es.js";
import { music_library_fr_examples } from "./generated/music-music-library.fr.js";
import { music_library_ja_examples } from "./generated/music-music-library.ja.js";
import { music_es_examples } from "./generated/music-music.es.js";
import { music_fr_examples } from "./generated/music-music.fr.js";
import { music_ja_examples } from "./generated/music-music.ja.js";
import { play_audio_es_examples } from "./generated/music-play-audio.es.js";
import { play_audio_fr_examples } from "./generated/music-play-audio.fr.js";
import { play_audio_ja_examples } from "./generated/music-play-audio.ja.js";
import { playback_es_examples } from "./generated/music-playback-op.es.js";
import { playback_fr_examples } from "./generated/music-playback-op.fr.js";
import { playback_ja_examples } from "./generated/music-playback-op.ja.js";
import { password_manager_es_examples } from "./generated/password-manager.es.js";
import { password_manager_fr_examples } from "./generated/password-manager.fr.js";
import { password_manager_ja_examples } from "./generated/password-manager.ja.js";
import { payments_es_examples } from "./generated/payments.es.js";
import { payments_fr_examples } from "./generated/payments.fr.js";
import { payments_ja_examples } from "./generated/payments.ja.js";
import { profile_es_examples } from "./generated/profile.es.js";
import { profile_fr_examples } from "./generated/profile.fr.js";
import { profile_ja_examples } from "./generated/profile.ja.js";
import { relationship_es_examples } from "./generated/relationship.es.js";
import { relationship_fr_examples } from "./generated/relationship.fr.js";
import { relationship_ja_examples } from "./generated/relationship.ja.js";
import { remote_desktop_es_examples } from "./generated/remote-desktop.es.js";
import { remote_desktop_fr_examples } from "./generated/remote-desktop.fr.js";
import { remote_desktop_ja_examples } from "./generated/remote-desktop.ja.js";
import { resolve_request_es_examples } from "./generated/resolve-request.es.js";
import { resolve_request_fr_examples } from "./generated/resolve-request.fr.js";
import { resolve_request_ja_examples } from "./generated/resolve-request.ja.js";
import { schedule_es_examples } from "./generated/schedule.es.js";
import { schedule_fr_examples } from "./generated/schedule.fr.js";
import { schedule_ja_examples } from "./generated/schedule.ja.js";
import { scheduled_task_es_examples } from "./generated/scheduled-task.es.js";
import { scheduled_task_fr_examples } from "./generated/scheduled-task.fr.js";
import { scheduled_task_ja_examples } from "./generated/scheduled-task.ja.js";
import { screen_time_es_examples } from "./generated/screen-time.es.js";
import { screen_time_fr_examples } from "./generated/screen-time.fr.js";
import { screen_time_ja_examples } from "./generated/screen-time.ja.js";
import { subscriptions_es_examples } from "./generated/subscriptions.es.js";
import { subscriptions_fr_examples } from "./generated/subscriptions.fr.js";
import { subscriptions_ja_examples } from "./generated/subscriptions.ja.js";
import { todo_es_examples } from "./generated/todos-todo.es.js";
import { todo_fr_examples } from "./generated/todos-todo.fr.js";
import { todo_ja_examples } from "./generated/todos-todo.ja.js";
import { toggle_feature_es_examples } from "./generated/toggle-feature.es.js";
import { toggle_feature_fr_examples } from "./generated/toggle-feature.fr.js";
import { toggle_feature_ja_examples } from "./generated/toggle-feature.ja.js";
import { voice_call_es_examples } from "./generated/voice-call.es.js";
import { voice_call_fr_examples } from "./generated/voice-call.fr.js";
import { voice_call_ja_examples } from "./generated/voice-call.ja.js";
import { website_block_es_examples } from "./generated/website-block.es.js";
import { website_block_fr_examples } from "./generated/website-block.fr.js";
import { website_block_ja_examples } from "./generated/website-block.ja.js";
import { workflow_es_examples } from "./generated/workflow-workflow.es.js";
import { workflow_fr_examples } from "./generated/workflow-workflow.fr.js";
import { workflow_ja_examples } from "./generated/workflow-workflow.ja.js";

export type PromptLocale = "en" | "es" | "fr" | "ja";

const SUPPORTED_LOCALES: ReadonlyArray<PromptLocale> = [
  "en",
  "es",
  "fr",
  "ja",
];

const DEFAULT_LOCALE: PromptLocale = "en";

export interface PromptExampleEntry {
  /** Stable key referenced by actions, e.g. `"life.brush_teeth"`. */
  exampleKey: string;
  /** Locale this entry covers. */
  locale: PromptLocale;
  /** Speaker turn for the user side. Use the standard `{{name1}}` template. */
  user: ActionExample;
  /** Speaker turn for the agent reply. Use the standard `{{agentName}}` template. */
  agent: ActionExample;
}

export interface PromptRegistryFilter {
  exampleKey?: string;
  locale?: PromptLocale;
}

export interface MultilingualPromptRegistry {
  register(entry: PromptExampleEntry): void;
  /** Returns the full pair (`[user, agent]`) or null if unregistered. */
  getPair(
    exampleKey: string,
    locale: PromptLocale,
  ): readonly [ActionExample, ActionExample] | null;
  /** Returns the matching entry or null. */
  get(exampleKey: string, locale: PromptLocale): PromptExampleEntry | null;
  /** Lists every entry, optionally filtered. */
  list(filter?: PromptRegistryFilter): PromptExampleEntry[];
  keys(): string[];
}

class InMemoryPromptRegistry implements MultilingualPromptRegistry {
  private readonly byKeyAndLocale = new Map<string, PromptExampleEntry>();

  register(entry: PromptExampleEntry): void {
    if (!entry.exampleKey) {
      throw new Error("PromptExampleEntry.exampleKey is required");
    }
    if (!isSupportedLocale(entry.locale)) {
      throw new Error(
        `PromptExampleEntry.locale "${entry.locale}" is not supported`,
      );
    }
    const compositeKey = makeCompositeKey(entry.exampleKey, entry.locale);
    if (this.byKeyAndLocale.has(compositeKey)) {
      throw new Error(
        `Prompt example "${entry.exampleKey}" already registered for locale "${entry.locale}"`,
      );
    }
    this.byKeyAndLocale.set(compositeKey, entry);
  }

  get(exampleKey: string, locale: PromptLocale): PromptExampleEntry | null {
    return (
      this.byKeyAndLocale.get(makeCompositeKey(exampleKey, locale)) ?? null
    );
  }

  getPair(
    exampleKey: string,
    locale: PromptLocale,
  ): readonly [ActionExample, ActionExample] | null {
    const entry = this.get(exampleKey, locale);
    if (!entry) {
      return null;
    }
    return [entry.user, entry.agent];
  }

  list(filter?: PromptRegistryFilter): PromptExampleEntry[] {
    const all = [...this.byKeyAndLocale.values()];
    if (!filter) {
      return all;
    }
    return all.filter((entry) => {
      if (filter.exampleKey && entry.exampleKey !== filter.exampleKey) {
        return false;
      }
      if (filter.locale && entry.locale !== filter.locale) {
        return false;
      }
      return true;
    });
  }

  keys(): string[] {
    const keys = new Set<string>();
    for (const entry of this.byKeyAndLocale.values()) {
      keys.add(entry.exampleKey);
    }
    return [...keys].sort();
  }
}

function isSupportedLocale(value: string): value is PromptLocale {
  return (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(value);
}

function makeCompositeKey(exampleKey: string, locale: PromptLocale): string {
  return `${locale}::${exampleKey}`;
}

export function createMultilingualPromptRegistry(): MultilingualPromptRegistry {
  return new InMemoryPromptRegistry();
}

// --- Runtime registration -------------------------------------------------

const REGISTRY_KEY = Symbol.for(
  "@elizaos/app-lifeops:multilingual-prompt-registry",
);

interface RegistryHostRuntime extends IAgentRuntime {
  [REGISTRY_KEY]?: MultilingualPromptRegistry;
}

export function registerMultilingualPromptRegistry(
  runtime: IAgentRuntime,
  registry: MultilingualPromptRegistry,
): void {
  (runtime as RegistryHostRuntime)[REGISTRY_KEY] = registry;
}

export function getMultilingualPromptRegistry(
  runtime: IAgentRuntime,
): MultilingualPromptRegistry | null {
  return (runtime as RegistryHostRuntime)[REGISTRY_KEY] ?? null;
}

// --- Default pack ---------------------------------------------------------

/**
 * Localized example for the LIFE create_definition flow that previously
 * lived inline in `actions/life.ts`. The Spanish row was the only inline
 * non-English example before W2-E; this table is the source-of-truth now.
 */
const LIFE_BRUSH_TEETH_EXAMPLES: ReadonlyArray<PromptExampleEntry> = [
  {
    exampleKey: "life.brush_teeth.create_definition",
    locale: "en",
    user: {
      name: "{{name1}}",
      content: {
        text: "help me brush my teeth at 8 am and 9 pm every day",
      },
    },
    agent: {
      name: "{{agentName}}",
      content: {
        text: 'I can set up a habit named "Brush teeth" for 8 am and 9 pm daily. Confirm and I\'ll save it.',
        actions: ["LIFE"],
      },
    },
  },
  {
    exampleKey: "life.brush_teeth.create_definition",
    locale: "es",
    user: {
      name: "{{name1}}",
      content: {
        text: "recuérdame cepillarme los dientes por la mañana y por la noche",
      },
    },
    agent: {
      name: "{{agentName}}",
      content: {
        text: "Puedo guardar ese hábito para la mañana y la noche. Confirma y lo guardo.",
        actions: ["LIFE"],
      },
    },
  },
];

/**
 * Generated translation packs from
 * `plugins/app-lifeops/scripts/translate-action-examples.mjs`. Each entry is
 * a Spanish or French translation of an English ActionExample pair found in
 * the source action file. The registry composite key is
 * `<actionName>.example.<index>`, which matches the index of the source pair
 * in the action's `examples: ActionExample[][]` array.
 *
 * Coverage: every example-bearing app-lifeops action × {es, fr}. Action files
 * outside app-lifeops are tracked as future bulk-pass scope in
 * `docs/audit/translation-harness.md`.
 */
const GENERATED_TRANSLATION_PACKS: ReadonlyArray<
  ReadonlyArray<PromptExampleEntry>
> = [
  app_block_es_examples,
  app_block_fr_examples,
  app_block_ja_examples,
  skill_es_examples,
  skill_fr_examples,
  skill_ja_examples,
  use_skill_es_examples,
  use_skill_fr_examples,
  use_skill_ja_examples,
  autofill_es_examples,
  autofill_fr_examples,
  autofill_ja_examples,
  block_es_examples,
  block_fr_examples,
  block_ja_examples,
  book_travel_es_examples,
  book_travel_fr_examples,
  book_travel_ja_examples,
  manage_browser_bridge_es_examples,
  manage_browser_bridge_fr_examples,
  manage_browser_bridge_ja_examples,
  calendar_es_examples,
  calendar_fr_examples,
  calendar_ja_examples,
  checkin_es_examples,
  checkin_fr_examples,
  checkin_ja_examples,
  connector_es_examples,
  connector_fr_examples,
  connector_ja_examples,
  credentials_es_examples,
  credentials_fr_examples,
  credentials_ja_examples,
  ask_user_question_es_examples,
  ask_user_question_fr_examples,
  ask_user_question_ja_examples,
  bash_es_examples,
  bash_fr_examples,
  bash_ja_examples,
  edit_es_examples,
  edit_fr_examples,
  edit_ja_examples,
  enter_worktree_es_examples,
  enter_worktree_fr_examples,
  enter_worktree_ja_examples,
  exit_worktree_es_examples,
  exit_worktree_fr_examples,
  exit_worktree_ja_examples,
  glob_es_examples,
  glob_fr_examples,
  glob_ja_examples,
  grep_es_examples,
  grep_fr_examples,
  grep_ja_examples,
  ls_es_examples,
  ls_fr_examples,
  ls_ja_examples,
  read_es_examples,
  read_fr_examples,
  read_ja_examples,
  web_fetch_es_examples,
  web_fetch_fr_examples,
  web_fetch_ja_examples,
  write_es_examples,
  write_fr_examples,
  write_ja_examples,
  desktop_es_examples,
  desktop_fr_examples,
  desktop_ja_examples,
  computer_use_es_examples,
  computer_use_fr_examples,
  computer_use_ja_examples,
  device_intent_es_examples,
  device_intent_fr_examples,
  device_intent_ja_examples,
  entity_es_examples,
  entity_fr_examples,
  entity_ja_examples,
  first_run_es_examples,
  first_run_fr_examples,
  first_run_ja_examples,
  health_es_examples,
  health_fr_examples,
  health_ja_examples,
  life_es_examples,
  life_fr_examples,
  life_ja_examples,
  lifeops_es_examples,
  lifeops_fr_examples,
  lifeops_ja_examples,
  clear_linear_activity_es_examples,
  clear_linear_activity_fr_examples,
  clear_linear_activity_ja_examples,
  create_linear_comment_es_examples,
  create_linear_comment_fr_examples,
  create_linear_comment_ja_examples,
  create_linear_issue_es_examples,
  create_linear_issue_fr_examples,
  create_linear_issue_ja_examples,
  delete_linear_comment_es_examples,
  delete_linear_comment_fr_examples,
  delete_linear_comment_ja_examples,
  delete_linear_issue_es_examples,
  delete_linear_issue_fr_examples,
  delete_linear_issue_ja_examples,
  get_linear_activity_es_examples,
  get_linear_activity_fr_examples,
  get_linear_activity_ja_examples,
  get_linear_issue_es_examples,
  get_linear_issue_fr_examples,
  get_linear_issue_ja_examples,
  linear_es_examples,
  linear_fr_examples,
  linear_ja_examples,
  list_linear_comments_es_examples,
  list_linear_comments_fr_examples,
  list_linear_comments_ja_examples,
  search_linear_issues_es_examples,
  search_linear_issues_fr_examples,
  search_linear_issues_ja_examples,
  update_linear_issue_es_examples,
  update_linear_issue_fr_examples,
  update_linear_issue_ja_examples,
  message_handoff_es_examples,
  message_handoff_fr_examples,
  message_handoff_ja_examples,
  money_es_examples,
  money_fr_examples,
  money_ja_examples,
  manage_routing_es_examples,
  manage_routing_fr_examples,
  manage_routing_ja_examples,
  manage_zones_es_examples,
  manage_zones_fr_examples,
  manage_zones_ja_examples,
  music_library_es_examples,
  music_library_fr_examples,
  music_library_ja_examples,
  music_es_examples,
  music_fr_examples,
  music_ja_examples,
  play_audio_es_examples,
  play_audio_fr_examples,
  play_audio_ja_examples,
  playback_es_examples,
  playback_fr_examples,
  playback_ja_examples,
  password_manager_es_examples,
  password_manager_fr_examples,
  password_manager_ja_examples,
  payments_es_examples,
  payments_fr_examples,
  payments_ja_examples,
  profile_es_examples,
  profile_fr_examples,
  profile_ja_examples,
  relationship_es_examples,
  relationship_fr_examples,
  relationship_ja_examples,
  remote_desktop_es_examples,
  remote_desktop_fr_examples,
  remote_desktop_ja_examples,
  resolve_request_es_examples,
  resolve_request_fr_examples,
  resolve_request_ja_examples,
  schedule_es_examples,
  schedule_fr_examples,
  schedule_ja_examples,
  scheduled_task_es_examples,
  scheduled_task_fr_examples,
  scheduled_task_ja_examples,
  screen_time_es_examples,
  screen_time_fr_examples,
  screen_time_ja_examples,
  subscriptions_es_examples,
  subscriptions_fr_examples,
  subscriptions_ja_examples,
  todo_es_examples,
  todo_fr_examples,
  todo_ja_examples,
  toggle_feature_es_examples,
  toggle_feature_fr_examples,
  toggle_feature_ja_examples,
  voice_call_es_examples,
  voice_call_fr_examples,
  voice_call_ja_examples,
  website_block_es_examples,
  website_block_fr_examples,
  website_block_ja_examples,
  workflow_es_examples,
  workflow_fr_examples,
  workflow_ja_examples,
];

export function registerDefaultPromptPack(
  registry: MultilingualPromptRegistry,
): void {
  for (const entry of LIFE_BRUSH_TEETH_EXAMPLES) {
    registry.register(entry);
  }
  for (const pack of GENERATED_TRANSLATION_PACKS) {
    for (const entry of pack) {
      registry.register(entry);
    }
  }
}

/**
 * Convenience for actions: build an `[user, agent]` pair list from a
 * (key, locale) tuple set. Throws when an entry is missing — actions
 * declare exactly which examples they need, so a missing one indicates a
 * registration error and should fail fast at module-init time.
 */
export function resolveActionExamplePairs(
  registry: MultilingualPromptRegistry,
  references: ReadonlyArray<{ exampleKey: string; locale: PromptLocale }>,
): ActionExample[][] {
  return references.map(({ exampleKey, locale }) => {
    const pair = registry.getPair(exampleKey, locale);
    if (!pair) {
      throw new Error(
        `Prompt example "${exampleKey}" (locale="${locale}") is not registered`,
      );
    }
    return [pair[0], pair[1]];
  });
}

export const PROMPT_REGISTRY_DEFAULT_LOCALE: PromptLocale = DEFAULT_LOCALE;

// --- Default registry singleton (module-load consumers) -------------------

/**
 * Module-level default registry, pre-populated with the default pack. Used
 * by actions that need to embed localized example pairs in their static
 * `examples: ActionExample[][]` arrays at module-load time (the runtime
 * registry isn't available at module-load).
 *
 * Runtime-scoped consumers should still use `getMultilingualPromptRegistry`
 * — this singleton is the read-only fallback for static contexts.
 */
let defaultRegistrySingleton: MultilingualPromptRegistry | null = null;

export function getDefaultPromptRegistry(): MultilingualPromptRegistry {
  if (!defaultRegistrySingleton) {
    const registry = createMultilingualPromptRegistry();
    registerDefaultPromptPack(registry);
    defaultRegistrySingleton = registry;
  }
  return defaultRegistrySingleton;
}

/**
 * Resolve a single localized example pair from the default registry.
 * Throws when the key isn't registered (intentional — fail fast at
 * module-init).
 */
export function getDefaultPromptExamplePair(
  exampleKey: string,
  locale: PromptLocale,
): readonly [ActionExample, ActionExample] {
  const pair = getDefaultPromptRegistry().getPair(exampleKey, locale);
  if (!pair) {
    throw new Error(
      `Prompt example "${exampleKey}" (locale="${locale}") is not registered in the default pack`,
    );
  }
  return pair;
}
