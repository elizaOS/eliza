import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import type { SkillScoreResponse, SkillScanResponse } from "../client/types.js";
import { getScoutClient } from "../runtime-store.js";

const GITHUB_REGEX = /github\.com\/([^/\s]+\/[^/\s]+)/;

function extractGitHubRepo(text: string): string | null {
  const match = text.match(GITHUB_REGEX);
  return match ? match[1] : null;
}

function formatSkillResult(result: SkillScoreResponse | SkillScanResponse, label: string): string {
  const lines = [
    `**Skill Scan: ${label}**`,
    "",
    `**Score**: ${result.score}/100`,
    `**Badge**: ${badgeEmoji(result.badge)} ${result.badge.toUpperCase()}`,
    `**Scanned**: ${result.scanned_at}`,
  ];

  if ("files_scanned" in result && result.files_scanned) {
    lines.push(`**Files Scanned**: ${result.files_scanned}`);
  }

  // Publisher info
  lines.push("", "**Publisher**:");
  lines.push(`- ${result.publisher.name} (score ${result.publisher.score}/100)${result.publisher.verified ? " [VERIFIED]" : ""}`);
  if (result.publisher.notes) {
    lines.push(`- ${result.publisher.notes}`);
  }

  // x402 endpoints
  if (result.endpoints.x402_endpoints.length > 0) {
    lines.push("", "**x402 Endpoints**:");
    for (const ep of result.endpoints.x402_endpoints) {
      const bazaar = ep.bazaar_score !== null ? ` (bazaar score: ${ep.bazaar_score})` : "";
      lines.push(`- ${ep.url} [${ep.status}]${bazaar}`);
    }
  }

  // External domains
  if (result.domains.unknown_domains.length > 0) {
    lines.push("", `**Unknown External Domains**: ${result.domains.unknown_domains.join(", ")}`);
  }

  // Recommendations
  lines.push("", "**Recommendation**:");
  lines.push(`- Install: ${result.recommendations.install ? "Yes" : "No"}`);
  lines.push(`- Escrow: ${result.recommendations.escrow}`);
  lines.push(`- ${result.recommendations.notes}`);
  if (result.recommendations.warnings.length > 0) {
    lines.push("", "**Warnings**:");
    result.recommendations.warnings.forEach((w) => lines.push(`- ${w}`));
  }

  return lines.join("\n");
}

export const scanSkillAction: Action = {
  name: "SCAN_SKILL",
  similes: [
    "SKILL_SCAN",
    "SECURITY_SCAN",
    "AUDIT_SKILL",
    "CHECK_SKILL",
    "MCP_SCAN",
    "SCAN_CODE",
  ],
  description:
    "Scan a skill or MCP server for security issues using Scout. Supports scanning by GitHub repo URL or by providing code files directly.",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const text = (message.content.text || "").toLowerCase();
    const hasScanKeyword = /\b(scan|audit|security|check|safe|trust)\b/.test(text);
    const hasSkillKeyword = /\b(skill|mcp|server|plugin|tool|code|repo)\b/.test(text);
    return hasScanKeyword && hasSkillKeyword;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const text = message.content.text || "";
    const client = getScoutClient(runtime);
    if (!client) {
      callback?.({ text: "Scout plugin is not properly initialized." });
      return { success: false };
    }

    // Try GitHub auto-fetch first
    const repo = extractGitHubRepo(text);
    if (repo) {
      try {
        const result = await client.getSkillScore("github", repo, { fetch: true });
        callback?.({ text: formatSkillResult(result, repo) });
        return { success: true, data: result as unknown as Record<string, unknown> };
      } catch (err: any) {
        callback?.({ text: `Failed to scan ${repo}: ${err.message}` });
        return { success: false };
      }
    }

    // If code files are attached in content (dynamic ELIZA content properties)
    const content = message.content as Record<string, unknown>;
    const files = content.files as Record<string, string> | undefined;
    if (files && Object.keys(files).length > 0) {
      try {
        const result = await client.scanSkill({
          source: "upload",
          identifier: (content.skillName as string) || "unknown-skill",
          files,
        });
        callback?.({ text: formatSkillResult(result, result.skill) });
        return { success: true, data: result as unknown as Record<string, unknown> };
      } catch (err: any) {
        callback?.({ text: `Skill scan failed: ${err.message}` });
        return { success: false };
      }
    }

    callback?.({ text: "To scan a skill, provide a GitHub URL (e.g., github.com/owner/repo) or attach code files." });
    return { success: false };
  },

  examples: [
    [
      { name: "User", content: { text: "Scan github.com/example/mcp-server for security issues" } },
    ],
  ],
};

function badgeEmoji(badge: string): string {
  switch (badge) {
    case "safe": return "[SAFE]";
    case "caution": return "[CAUTION]";
    case "warning": return "[WARNING]";
    case "danger": return "[DANGER]";
    default: return "";
  }
}