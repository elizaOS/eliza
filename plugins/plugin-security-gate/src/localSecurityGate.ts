/**
 * Deterministic local security & prompt injection analyzer.
 * Runs 100% locally with sub-millisecond execution time, zero external network calls.
 */

export interface LocalAuditResult {
  verdict: "ALLOW" | "WARN" | "BLOCK";
  risk_score: number;
  threats: string[];
  executionTimeMs: number;
}

const INJECTION_PATTERNS = [
  {
    pattern: /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
    threat: "Prompt Injection: Instruction Override",
    risk: 90,
  },
  {
    pattern: /you\s+are\s+now\s+(in\s+)?dan\s+mode/i,
    threat: "Jailbreak: DAN Mode Persona",
    risk: 95,
  },
  {
    pattern: /developer\s+mode\s+(enabled|activated)/i,
    threat: "Jailbreak: Developer Mode Override",
    risk: 85,
  },
  {
    pattern: /bypass\s+(safety|content|security)\s+filters?/i,
    threat: "Security Filter Bypass Attempt",
    risk: 90,
  },
  {
    pattern: /system\s*:\s*override/i,
    threat: "System Prompt Spoofing",
    risk: 85,
  },
  {
    pattern: /disregard\s+(all\s+)?(system|rules|guidelines)/i,
    threat: "System Rule Disregard",
    risk: 90,
  },
];

const CODE_HAZARD_PATTERNS = [
  {
    pattern: /\b(os\.system|subprocess\.(Popen|run|call)|exec\(|eval\()/i,
    threat: "Malicious Code Execution Pattern",
    risk: 95,
  },
  {
    pattern: /\b(rm\s+-rf|del\s+\/f|\bformat\s+[a-z]:)/i,
    threat: "Destructive File System Command",
    risk: 98,
  },
  {
    pattern: /powershell(\.exe)?\s+(-enc|-encodedcommand)/i,
    threat: "Obfuscated PowerShell Execution",
    risk: 95,
  },
  {
    pattern: /__import__\s*\(\s*['"]os['"]\s*\)/i,
    threat: "Dynamic Import Execution Pattern",
    risk: 95,
  },
];

const CREDENTIAL_LEAK_PATTERNS = [
  {
    pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
    threat: "Private Key Disclosure Attempt",
    risk: 99,
  },
  {
    pattern: /\b0x[a-fA-F0-9]{64}\b/,
    threat: "Raw Hex Private Key / Seed Material Detected",
    risk: 95,
  },
];

/**
 * Heuristically detects whether a given payload contains code structures or scripts.
 */
export function isCodePayload(content: string): boolean {
  if (!content) return false;
  // Markdown code fence blocks
  if (/```[\s\S]*?```/.test(content)) return true;
  // Common programming language declarations & patterns
  const codePatterns = [
    /(?:^|\n)\s*(?:import\s+|from\s+[\w.]+\s+import|export\s+|def\s+\w+\s*\(|class\s+\w+[:\s]|function\s+\w*\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=)/,
    /(?:os\.system|subprocess\.|exec\(|eval\(|console\.log|print\(|\bif\s*\(.*?\)\s*\{)/,
    /(?:^|\n)\s*(?:if\s+__name__\s*==\s*['"]__main__['"]|#!\/bin\/(?:ba)?sh|#!\/usr\/bin\/env)/,
  ];
  return codePatterns.some((p) => p.test(content));
}

export function inspectPayloadLocally(content: string): LocalAuditResult {
  const startTime = Date.now();
  const rawText = content || "";
  // Google-grade defense: normalize evasion vectors (null bytes, zero-width chars) before pattern matching
  const text = rawText
    .replace(/\0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
  const threats: string[] = [];
  let maxRisk = 0;

  for (const { pattern, threat, risk } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      threats.push(threat);
      maxRisk = Math.max(maxRisk, risk);
    }
  }

  for (const { pattern, threat, risk } of CODE_HAZARD_PATTERNS) {
    if (pattern.test(text)) {
      threats.push(threat);
      maxRisk = Math.max(maxRisk, risk);
    }
  }

  for (const { pattern, threat, risk } of CREDENTIAL_LEAK_PATTERNS) {
    if (pattern.test(text)) {
      threats.push(threat);
      maxRisk = Math.max(maxRisk, risk);
    }
  }

  let verdict: "ALLOW" | "WARN" | "BLOCK" = "ALLOW";
  if (maxRisk >= 75) {
    verdict = "BLOCK";
  } else if (maxRisk >= 30) {
    verdict = "WARN";
  }

  return {
    verdict,
    risk_score: maxRisk,
    threats,
    executionTimeMs: Math.max(1, Date.now() - startTime),
  };
}
