/**
 * Permanent secret replacement for corpus scrub stage 1. This pass only handles
 * high-confidence credentials and secret-shaped tokens; broader human PII stays
 * for the later delete/rewrite passes so API keys never leave the local machine
 * while narrative identity context remains available to the owner-reviewed
 * pipeline.
 */
import { createHash } from "node:crypto";
import { detectPii, SecretSwapSession } from "@elizaos/core";
import type { CorpusMessage } from "../schema.ts";

export interface SecretReplacement {
  kind: string;
  valueHash: string;
  placeholder: string;
}

export interface SecretSwapResult {
  message: CorpusMessage;
  replacements: SecretReplacement[];
}

export interface SwapSecretsOptions {
  hashSalt: string;
  knownSecrets?: Record<string, string | undefined>;
}

const SECRET_DETECTOR_KINDS = new Set([
  "anthropic-key",
  "aws-access-key",
  "basic-auth-header",
  "github-token",
  "google-api-key",
  "google-oauth-refresh-token",
  "hex-secret",
  "jwt",
  "openai-key",
  "pgp-private-key",
  "private-key",
  "seed-phrase",
  "slack-token",
  "slack-webhook-url",
  "stripe-key",
  "stripe-webhook-secret",
  "telegram-bot-token",
  "url-credentials",
  "wif-private-key",
]);

const SECRET_PLACEHOLDER_PATTERN = /\[\[SECRET:[a-z0-9-]+:[a-f0-9]{12}\]\]/g;

function stableValueHash(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}\0${value}`).digest("hex");
}

function placeholderFor(kind: string, valueHash: string): string {
  const normalizedKind = kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `[[SECRET:${normalizedKind || "secret"}:${valueHash.slice(0, 12)}]]`;
}

function shouldCollect(value: string): boolean {
  SECRET_PLACEHOLDER_PATTERN.lastIndex = 0;
  return value.trim().length >= 8 && !SECRET_PLACEHOLDER_PATTERN.test(value);
}

function collectSecretValues(
  text: string,
  knownSecrets: Record<string, string | undefined>,
): Map<string, string> {
  const byValue = new Map<string, string>();
  const session = new SecretSwapSession({ knownSecrets });
  session.substituteText(text);
  for (const entry of session.entries) {
    const trimmed = entry.value.trim();
    if (
      shouldCollect(trimmed) &&
      (SECRET_DETECTOR_KINDS.has(entry.kind) ||
        entry.kind === "secret" ||
        entry.kind in knownSecrets)
    ) {
      byValue.set(trimmed, entry.kind);
    }
  }
  for (const match of detectPii(text)) {
    const trimmed = match.value.trim();
    if (SECRET_DETECTOR_KINDS.has(match.kind) && byValue.has(trimmed)) {
      byValue.set(trimmed, match.kind);
    }
  }
  return byValue;
}

export function swapPermanentSecrets(
  message: CorpusMessage,
  options: SwapSecretsOptions,
): SecretSwapResult {
  const byValue = collectSecretValues(message.text, options.knownSecrets ?? {});
  const replacements = [...byValue.entries()]
    .map(([value, kind]) => {
      const valueHash = stableValueHash(value, options.hashSalt);
      return {
        kind,
        value,
        valueHash,
        placeholder: placeholderFor(kind, valueHash),
      };
    })
    .sort(
      (a, b) => b.value.length - a.value.length || a.kind.localeCompare(b.kind),
    );
  let text = message.text;
  for (const replacement of replacements) {
    text = text.split(replacement.value).join(replacement.placeholder);
  }
  return {
    message: {
      ...message,
      text,
      scrubState: "swapped",
    },
    replacements: replacements.map(({ kind, valueHash, placeholder }) => ({
      kind,
      valueHash,
      placeholder,
    })),
  };
}
