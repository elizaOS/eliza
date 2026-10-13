import type { CryptoAddressFinding, CanaryGuardResult } from "../types";

const INVISIBLE_CHARACTERS = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;
const ROLE_DELIMITER = /\[\/?INST\]|<\|(?:im_start|im_end|system|developer|assistant|user)\|>|<<\/?SYS>>/i;
const ROLE_HIJACK = /(?:^|[\r\n])\s*(?:system|developer)(?:\s*(?:override|prompt|message|mode|instruction))*\s*:\s*(?:you are|ignore|disregard|forget|override|act as|now|from now on|new instructions?)/i;
const INSTRUCTION_OVERRIDE = /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|our|previous|prior|earlier|above|system|developer)\s+)*(?:instructions?|prompts?|rules?|messages?)\b/i;
const WALLET_ASSET_COMMAND = /\b(?:drain|sweep)\s+(?:(?:all|every|entire|the|your|my|our|any|remaining)\s+)*(?:funds?|balances?|assets?|tokens?|crypto|eth|sol|usdc|usdt|wallet)\b/i;
const WALLET_DESTINATION_COMMAND = /\b(?:send|transfer|wire|move|drain)\s+(?:(?:all|every|entire|the|your|my|our|any|remaining|it|them)\s+)*(?:funds?|balances?|assets?|tokens?|crypto|eth|sol|usdc|usdt)?\s*(?:it\s+|them\s+)?to\s+(?:0x[a-f0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/i;
const EVM_ADDRESS = /\b0x[a-f0-9]{40}\b/gi;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/**
 * Unwraps untrusted user messages enclosed by core's external-content envelope.
 * Core wraps messages with <<<EXTERNAL_UNTRUSTED_CONTENT ... >>> which must be
 * unwrapped so angle brackets are not mistaken for raw HTML markup.
 */
export function unwrapUserMessageTextForDetection(text: string): string {
  if (!text) return "";
  const match = text.match(/<<<EXTERNAL_UNTRUSTED_CONTENT\s*([\s\S]*?)\s*>>>/i);
  return match ? match[1].trim() : text;
}

function stripHtml(content: string, findings: Set<string>): string {
  let cleaned = content;
  if (/<(script|style|iframe|object|embed|svg|template)[^>]*>[\s\S]*?<\/\1>/gi.test(cleaned)) {
    findings.add("active_html_removed");
    cleaned = cleaned.replace(/<(script|style|iframe|object|embed|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, "");
  }
  if (/on\w+\s*=\s*["'][^"']*["']/gi.test(cleaned) || /javascript:/gi.test(cleaned)) {
    findings.add("unsafe_html_attributes_removed");
  }
  if (
    /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0)[^"']*["']/i.test(cleaned) ||
    /\b(?:hidden|aria-hidden\s*=\s*["']true["'])\b/i.test(cleaned) ||
    /<input[^>]+type\s*=\s*["']hidden["']/i.test(cleaned)
  ) {
    findings.add("html_hidden_content_removed");
  }
  if (/<[^>]+>/g.test(cleaned)) {
    findings.add("html_markup_removed");
    cleaned = cleaned.replace(/<[^>]+>/g, " ");
  }
  return cleaned;
}

function matchesWalletCommand(value: string): boolean {
  return WALLET_ASSET_COMMAND.test(value) || WALLET_DESTINATION_COMMAND.test(value);
}

function commandThreats(value: string): string[] {
  const normalized = value.normalize("NFKC");
  const found: string[] = [];
  if (ROLE_DELIMITER.test(normalized) || ROLE_HIJACK.test(normalized)) found.push("role_delimiter_override");
  if (INSTRUCTION_OVERRIDE.test(normalized)) found.push("instruction_override");
  if (matchesWalletCommand(normalized)) found.push("wallet_transfer_command");
  return found;
}

function tidy(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function scrubCommandLines(value: string): string {
  const blockedMarker = "[CANARY_REMOVED_INSTRUCTION]";
  let marked = value.normalize("NFKC");
  const patterns = [ROLE_DELIMITER, ROLE_HIJACK, INSTRUCTION_OVERRIDE, WALLET_ASSET_COMMAND, WALLET_DESTINATION_COMMAND];
  for (const pattern of patterns) {
    const flags = pattern.multiline ? "gim" : "gi";
    marked = marked.replace(new RegExp(pattern.source, flags), (match) => match.split("\n").map(() => blockedMarker).join("\n"));
  }
  return tidy(marked.split("\n").filter((line) => !line.includes(blockedMarker)).join("\n"));
}

function extractAddresses(value: string): CryptoAddressFinding[] {
  const normalized = value.normalize("NFKC");
  const addresses = new Map<string, CryptoAddressFinding>();

  for (const match of normalized.matchAll(EVM_ADDRESS)) {
    const address = match[0];
    const key = address.toLowerCase();
    const context = normalized.slice(Math.max(0, match.index - 160), match.index + address.length + 40);
    const reasons = ["unverified_evm_address"];
    let riskScore = 0.1;
    if (/^0x(?:0{40}|0{36}dead)$/i.test(address)) {
      reasons.push("burn_destination");
      riskScore = 0.7;
    }
    if (matchesWalletCommand(context)) {
      reasons.push("wallet_transfer_command_nearby");
      riskScore = 0.98;
    }
    const existing = addresses.get(key);
    if (!existing || existing.risk_score < riskScore) addresses.set(key, { address, risk_score: riskScore, reasons, chain: "evm" });
  }

  for (const match of normalized.matchAll(SOLANA_ADDRESS)) {
    const address = match[0];
    const key = address;
    const context = normalized.slice(Math.max(0, match.index - 160), match.index + address.length + 40);
    if (matchesWalletCommand(context) || /\b(?:sol|solana|wallet|transfer|send)\b/i.test(context)) {
      const reasons = ["unverified_solana_address"];
      let riskScore = 0.2;
      if (matchesWalletCommand(context)) {
        reasons.push("wallet_transfer_command_nearby");
        riskScore = 0.98;
      }
      const existing = addresses.get(key);
      if (!existing || existing.risk_score < riskScore) addresses.set(key, { address, risk_score: riskScore, reasons, chain: "solana" });
    }
  }

  return [...addresses.values()];
}

/**
 * Local deterministic heuristic detector engine.
 * Executes in <0.1ms with zero network calls and zero data exfiltration.
 */
export function sanitizeLocally(content: string, strictMode = false): CanaryGuardResult {
  const unwrappedContent = unwrapUserMessageTextForDetection(content);
  const findings = new Set<string>();
  const normalizedContent = unwrappedContent.replace(INVISIBLE_CHARACTERS, "");
  if (normalizedContent !== unwrappedContent) findings.add("concealed_unicode_removed");
  const strippedText = stripHtml(normalizedContent, findings);
  const detectedCommands = new Set([
    ...commandThreats(normalizedContent),
    ...commandThreats(strippedText),
  ]);
  for (const threat of detectedCommands) findings.add(threat);
  const injectionDetected = detectedCommands.size > 0;
  const addresses = extractAddresses(normalizedContent);
  let sanitizedContent = tidy(strippedText);
  if (injectionDetected) {
    sanitizedContent = strictMode ? "" : scrubCommandLines(sanitizedContent);
  }
  sanitizedContent = sanitizedContent.replace(/\[\/?INST\]|<\|(?:im_start|im_end|system|developer|assistant|user)\|>|<<\/?SYS>>/gi, "");
  sanitizedContent = tidy(sanitizedContent);

  let riskScore = 0.01;
  if (findings.has("html_markup_removed")) riskScore = 0.05;
  if (findings.has("concealed_unicode_removed") || findings.has("html_hidden_content_removed")) riskScore = Math.max(riskScore, 0.2);
  if (findings.has("active_html_removed") || findings.has("unsafe_html_attributes_removed")) riskScore = Math.max(riskScore, 0.4);
  if (detectedCommands.has("role_delimiter_override")) riskScore = Math.max(riskScore, 0.85);
  if (detectedCommands.has("instruction_override")) riskScore = Math.max(riskScore, 0.95);
  if (detectedCommands.has("wallet_transfer_command")) riskScore = Math.max(riskScore, 0.98);
  for (const address of addresses) riskScore = Math.max(riskScore, address.risk_score);

  return {
    status: injectionDetected ? (strictMode ? "blocked" : "sanitized") : findings.size ? "sanitized" : "clean",
    risk_score: riskScore,
    injection_detected: injectionDetected,
    threats_neutralized: [...findings].sort(),
    sanitized_content: sanitizedContent,
    safety_receipt: "canary-v1-verified",
    crypto_addresses: addresses,
    mode: "local",
    inspection: {
      method: "deterministic-rules-engine",
      guaranteed_safe: false,
      risk_score_semantics: "heuristic severity, not a probability",
      limitations: [
        "Does not detect every obfuscated, multilingual, or novel instruction attack.",
        "Does not execute dynamic script contexts or linked resources.",
        "Address scores reflect lexical context and do not certify onchain safety.",
      ],
    },
  };
}
