/**
 * @elizaos/import-conversations — bring prior AI conversation history
 * (ChatGPT / Claude / Hermes / OpenClaw exports) into elizaOS as searchable, scoped
 * knowledge.
 *
 * Track A ships the shared core: the normalized conversation contract, the
 * secret-redacting / transcript-rendering ingestion pipeline (storing through
 * an injectable DocumentSink port), idempotency + uninstall manifest, plan/apply
 * report, and the importer registry that source parsers (Tracks B/C/D) register
 * against.
 */

export * from "./adapters/index.ts";
export * from "./core/index.ts";
export type { ChatGptParseOptions } from "./parsers/chatgpt.ts";
export {
  chatgptParser,
  flattenChatGptConversation,
  streamJsonArrayElements,
} from "./parsers/chatgpt.ts";
export type { ParseOptions as ClaudeParseOptions } from "./parsers/claude.ts";
export {
  default as claudeParser,
  detect as detectClaudeExport,
  parse as parseClaudeExport,
} from "./parsers/claude.ts";
export type { ParseOptions } from "./parsers/hermes.ts";
export { default as hermesParser, detect, parse } from "./parsers/hermes.ts";
export type { OpenClawParseOptions } from "./parsers/openclaw.ts";
export {
  default as openclawParser,
  detect as detectOpenClawHome,
  parse as parseOpenClawHome,
} from "./parsers/openclaw.ts";
