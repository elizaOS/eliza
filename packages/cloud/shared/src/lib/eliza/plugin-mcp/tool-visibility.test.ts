/**
 * Covers the two-tier MCP tool visibility config.
 *
 * `CRUCIAL_TOOLS` is module-level state, and the crucial action-name set is
 * built once and cached. So the accessors' documented "returns a copy" contract
 * is load-bearing: if a caller can reach the live arrays, a single `push` or
 * `splice` permanently changes which tools every agent sees in its prompt, and
 * the cached name set makes the corruption inconsistent on top of that.
 *
 * Pure config + lookups — no MCP transport.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  getAllCrucialTools,
  getCrucialToolsForServer,
  isCrucialTool,
  shouldRegisterRawMcpTools,
} from "./tool-visibility";

const INJECTED = "injected_tool";

// If an accessor leaks the live array, the mutation cases below would corrupt
// module state for every later case. Undo it so each case stands alone and the
// failures reported are the real ones rather than knock-on damage.
afterEach(() => {
  for (const tools of Object.values(getAllCrucialTools())) {
    const at = tools.indexOf(INJECTED);
    if (at !== -1) tools.splice(at, 1);
  }
});

describe("isCrucialTool", () => {
  test("recognizes a configured tool", () => {
    expect(isCrucialTool("google", "gmail_send")).toBe(true);
    expect(isCrucialTool("github", "github_status")).toBe(true);
  });

  test("normalizes server and tool the same way action naming does", () => {
    expect(isCrucialTool("Google", "GMAIL_SEND")).toBe(true);
    expect(isCrucialTool("  google  ", "gmail send")).toBe(true);
    expect(isCrucialTool("google", "gmail-send")).toBe(true);
  });

  test("rejects a tool that is not configured for that server", () => {
    expect(isCrucialTool("google", "gmail_delete_everything")).toBe(false);
    expect(isCrucialTool("unknown-server", "gmail_send")).toBe(false);
  });

  test("does not treat a tool as crucial for the wrong server", () => {
    // `calendar_list_events` is crucial for google and microsoft only.
    expect(isCrucialTool("github", "calendar_list_events")).toBe(false);
  });

  test("returns a stable answer across repeated calls", () => {
    // The name set is built once and cached.
    expect([
      isCrucialTool("google", "gmail_send"),
      isCrucialTool("google", "gmail_send"),
      isCrucialTool("google", "gmail_send"),
    ]).toEqual([true, true, true]);
  });
});

describe("getCrucialToolsForServer", () => {
  test("returns the configured tools, matching the server case-insensitively", () => {
    expect(getCrucialToolsForServer("google")).toContain("gmail_send");
    expect(getCrucialToolsForServer("GOOGLE")).toContain("gmail_send");
  });

  test("returns an empty list for an unknown server", () => {
    expect(getCrucialToolsForServer("nope")).toEqual([]);
    expect(getCrucialToolsForServer("")).toEqual([]);
  });

  test("does not hand the caller the live config array", () => {
    // A push here would permanently change what every agent sees.
    const first = getCrucialToolsForServer("google");
    first.push(INJECTED);
    expect(getCrucialToolsForServer("google")).not.toContain(INJECTED);
  });
});

describe("getAllCrucialTools", () => {
  test("exposes every configured server", () => {
    const all = getAllCrucialTools();
    expect(Object.keys(all).length).toBeGreaterThan(0);
    expect(all.google).toContain("gmail_send");
  });

  test("is not the live object", () => {
    const copy = getAllCrucialTools();
    copy.injectedServer = ["x"];
    expect(getAllCrucialTools()).not.toHaveProperty("injectedServer");
  });

  test("does not share its nested arrays with the live config", () => {
    // A shallow copy still leaks every tool list by reference.
    const copy = getAllCrucialTools();
    copy.google?.push(INJECTED);
    expect(getAllCrucialTools().google).not.toContain(INJECTED);
    expect(getCrucialToolsForServer("google")).not.toContain(INJECTED);
  });
});

describe("config integrity", () => {
  test("every server lists at least one tool and no duplicates", () => {
    for (const [server, tools] of Object.entries(getAllCrucialTools())) {
      expect(tools.length, `${server} must list tools`).toBeGreaterThan(0);
      expect(new Set(tools).size, `${server} must not repeat a tool`).toBe(tools.length);
    }
  });

  test("every configured tool is reported as crucial for its own server", () => {
    for (const [server, tools] of Object.entries(getAllCrucialTools())) {
      for (const tool of tools) {
        expect(isCrucialTool(server, tool), `${server}/${tool}`).toBe(true);
      }
    }
  });

  test("server keys are lowercase, so the lookup can find them", () => {
    for (const server of Object.keys(getAllCrucialTools())) {
      expect(server).toBe(server.toLowerCase());
    }
  });
});

describe("shouldRegisterRawMcpTools", () => {
  test("registers raw tools for an ordinary server", () => {
    for (const server of ["google", "github", "", "doordash-clone"]) {
      expect(shouldRegisterRawMcpTools(server)).toBe(true);
    }
  });

  test("withholds them for doordash, case- and whitespace-insensitively", () => {
    for (const server of ["doordash", "DoorDash", "  DOORDASH  "]) {
      expect(shouldRegisterRawMcpTools(server)).toBe(false);
    }
  });
});
