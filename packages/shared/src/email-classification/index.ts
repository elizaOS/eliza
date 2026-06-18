/**
 * Email-classification primitives (canonical, runtime-level).
 *
 * A two-stage (rule pass + LLM fallback) classifier plus the untrusted-content
 * fence used before email text reaches a prompt. Depends only on
 * `@elizaos/core`; no DB, no plugin imports. Consumed by inbox-curation and
 * finance bill-extraction in `@elizaos/plugin-personal-assistant`, which keeps
 * a thin re-export shim for backwards compatibility.
 */

export * from "./email-classifier.js";
export * from "./wrap-untrusted-email-content.js";
