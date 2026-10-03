/**
 * Pins the exec-approvals resolution and matching layer that every SHELL
 * gate consults. Exercises the real normalize/resolve/match functions
 * (no mocks of the system under test) so a load that used to delete
 * `agents.default` cannot silently drop operator security config.
 */
import { describe, expect, it } from "vitest";
import {
  matchAllowlist,
  normalizeApprovals,
  resolveApprovalsFromFile,
} from "../approvals/allowlist";
import type {
  CommandResolution,
  ExecAllowlistEntry,
  ExecApprovalsFile,
} from "../approvals/types";
import { EXEC_APPROVAL_DEFAULTS } from "../approvals/types";

const DEFAULT_AGENT_ID = "default";

function fileWith(agents: ExecApprovalsFile["agents"]): ExecApprovalsFile {
  return { version: 1, agents };
}

function resolution(resolvedPath: string): CommandResolution {
  return {
    rawExecutable: resolvedPath,
    resolvedPath,
    executableName: resolvedPath.split("/").pop() ?? resolvedPath,
  };
}

describe("normalizeApprovals preserves agents.default", () => {
  it("keeps an explicit default-agent security and allowlist through normalize", () => {
    const input = fileWith({
      [DEFAULT_AGENT_ID]: {
        security: "full",
        allowlist: [{ pattern: "/usr/bin/git" }],
      },
      alice: { security: "deny" },
    });

    const normalized = normalizeApprovals(input);

    expect(normalized.agents?.[DEFAULT_AGENT_ID]?.security).toBe("full");
    expect(normalized.agents?.[DEFAULT_AGENT_ID]?.allowlist).toEqual([
      expect.objectContaining({ pattern: "/usr/bin/git" }),
    ]);
    expect(normalized.agents?.alice?.security).toBe("deny");
    expect(normalized.agents?.[DEFAULT_AGENT_ID]).toBeDefined();
    expect(Object.keys(normalized.agents ?? {})).toEqual(
      expect.arrayContaining([DEFAULT_AGENT_ID, "alice"]),
    );
  });

  it("assigns allowlist entry ids without dropping the default agent", () => {
    const normalized = normalizeApprovals(
      fileWith({
        [DEFAULT_AGENT_ID]: {
          security: "allowlist",
          allowlist: [{ pattern: "/usr/bin/git" }],
        },
      }),
    );

    const entry = normalized.agents?.[DEFAULT_AGENT_ID]?.allowlist?.[0];
    expect(entry?.pattern).toBe("/usr/bin/git");
    expect(typeof entry?.id).toBe("string");
    expect(entry?.id?.length).toBeGreaterThan(0);
  });
});

describe("resolveApprovalsFromFile precedence", () => {
  it("returns the default agent's configured values when agentId is omitted", () => {
    const resolved = resolveApprovalsFromFile({
      file: fileWith({
        [DEFAULT_AGENT_ID]: {
          security: "full",
          ask: "off",
          allowlist: [{ pattern: "/usr/bin/git" }],
        },
      }),
    });

    expect(resolved.agent.security).toBe("full");
    expect(resolved.agent.ask).toBe("off");
    expect(resolved.allowlist).toEqual([
      expect.objectContaining({ pattern: "/usr/bin/git" }),
    ]);
  });

  it("survives a JSON persist round-trip of the normalized default agent", () => {
    const normalized = normalizeApprovals(
      fileWith({
        [DEFAULT_AGENT_ID]: {
          security: "allowlist",
          ask: "always",
          allowlist: [{ pattern: "/usr/bin/git" }],
        },
      }),
    );
    const rehydrated = JSON.parse(
      JSON.stringify(normalized),
    ) as ExecApprovalsFile;
    const resolved = resolveApprovalsFromFile({
      file: rehydrated,
    });

    expect(rehydrated.agents?.[DEFAULT_AGENT_ID]?.security).toBe("allowlist");
    expect(resolved.agent.security).toBe("allowlist");
    expect(resolved.agent.ask).toBe("always");
  });

  it("prefers a named agent over wildcard, file defaults, and shipped defaults", () => {
    const resolved = resolveApprovalsFromFile({
      file: {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {
          "*": { security: "full", ask: "always" },
          alice: { security: "deny", ask: "off" },
        },
      },
      agentId: "alice",
    });

    expect(resolved.agent.security).toBe("deny");
    expect(resolved.agent.ask).toBe("off");
  });

  it("prefers wildcard over file defaults when the named agent is absent", () => {
    const resolved = resolveApprovalsFromFile({
      file: {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {
          "*": { security: "full", ask: "always" },
        },
      },
      agentId: "bob",
    });

    expect(resolved.agent.security).toBe("full");
    expect(resolved.agent.ask).toBe("always");
  });

  it("prefers file defaults over shipped EXEC_APPROVAL_DEFAULTS", () => {
    const resolved = resolveApprovalsFromFile({
      file: {
        version: 1,
        defaults: { security: "full", ask: "off" },
        agents: {},
      },
    });

    expect(resolved.agent.security).toBe("full");
    expect(resolved.agent.ask).toBe("off");
  });

  it("falls back to shipped defaults when no file or agent values are set", () => {
    const resolved = resolveApprovalsFromFile({
      file: fileWith({}),
    });

    expect(resolved.agent.security).toBe(EXEC_APPROVAL_DEFAULTS.security);
    expect(resolved.agent.ask).toBe(EXEC_APPROVAL_DEFAULTS.ask);
    expect(resolved.agent.askFallback).toBe(EXEC_APPROVAL_DEFAULTS.askFallback);
    expect(resolved.agent.autoAllowSkills).toBe(
      EXEC_APPROVAL_DEFAULTS.autoAllowSkills,
    );
  });

  it("fails closed on invalid security and ask values", () => {
    const resolved = resolveApprovalsFromFile({
      file: {
        version: 1,
        defaults: {
          security: "permissive" as never,
          ask: "sometimes" as never,
        },
        agents: {
          [DEFAULT_AGENT_ID]: {
            security: "maybe" as never,
            ask: "later" as never,
          },
        },
      },
    });

    expect(resolved.defaults.security).toBe(EXEC_APPROVAL_DEFAULTS.security);
    expect(resolved.defaults.ask).toBe(EXEC_APPROVAL_DEFAULTS.ask);
    expect(resolved.agent.security).toBe(EXEC_APPROVAL_DEFAULTS.security);
    expect(resolved.agent.ask).toBe(EXEC_APPROVAL_DEFAULTS.ask);
  });

  it("concatenates wildcard then agent allowlist entries", () => {
    const resolved = resolveApprovalsFromFile({
      file: fileWith({
        "*": { allowlist: [{ pattern: "/usr/bin/ls" }] },
        [DEFAULT_AGENT_ID]: { allowlist: [{ pattern: "/usr/bin/git" }] },
      }),
    });

    expect(resolved.allowlist.map((entry) => entry.pattern)).toEqual([
      "/usr/bin/ls",
      "/usr/bin/git",
    ]);
  });
});

describe("matchAllowlist", () => {
  const git = resolution("/usr/bin/git");

  it("does not match a bare executable name", () => {
    const entries: ExecAllowlistEntry[] = [{ pattern: "git" }];
    expect(matchAllowlist(entries, git)).toBeNull();
  });

  it("matches a concrete path and ignores case on the path", () => {
    const entries: ExecAllowlistEntry[] = [{ pattern: "/USR/BIN/GIT" }];
    expect(matchAllowlist(entries, git)?.pattern).toBe("/USR/BIN/GIT");
  });

  it("scopes a single * to one path segment", () => {
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/*" }];
    expect(matchAllowlist(entries, git)?.pattern).toBe("/usr/bin/*");
    expect(
      matchAllowlist(entries, resolution("/usr/local/bin/git")),
    ).toBeNull();
  });

  it("lets ** cross path segments", () => {
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/**/git" }];
    expect(
      matchAllowlist(entries, resolution("/usr/local/bin/git"))?.pattern,
    ).toBe("/usr/**/git");
    expect(matchAllowlist(entries, git)?.pattern).toBe("/usr/**/git");
  });

  it("returns null when resolution is missing or has no path", () => {
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/git" }];
    expect(matchAllowlist(entries, null)).toBeNull();
    expect(
      matchAllowlist(entries, {
        rawExecutable: "git",
        resolvedPath: "",
        executableName: "git",
      }),
    ).toBeNull();
  });

  it("returns null for an empty allowlist", () => {
    expect(matchAllowlist([], git)).toBeNull();
  });
});
