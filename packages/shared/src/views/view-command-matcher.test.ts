/**
 * Tests for deterministic multilingual view-command matcher.
 */
import { describe, expect, it } from "vitest";
import { MATCHER_VIEW_IDS, matchViewCommand } from "./view-command-matcher.ts";

describe("matchViewCommand", () => {
  it("matches English view navigation commands", () => {
    expect(matchViewCommand("open settings")).toBe("settings");
    expect(matchViewCommand("go to calendar")).toBe("calendar");
    expect(matchViewCommand("show me my wallet")).toBe("wallet");
    expect(matchViewCommand("my todos")).toBe("todos");
    expect(matchViewCommand("notes page")).toBe("notes");
    expect(matchViewCommand("go back")).toBe("chat");
  });

  it("matches Spanish view navigation commands", () => {
    expect(matchViewCommand("abre ajustes")).toBe("settings");
    expect(matchViewCommand("ir a billetera")).toBe("wallet");
    expect(matchViewCommand("muéstrame el calendario")).toBe("calendar");
  });

  it("matches Portuguese view navigation commands", () => {
    expect(matchViewCommand("abra configurações")).toBe("settings");
    expect(matchViewCommand("mostra minhas tarefas")).toBe("todos");
  });

  it("matches French view navigation commands", () => {
    expect(matchViewCommand("ouvre les paramètres")).toBe("settings");
    expect(matchViewCommand("affiche mon calendrier")).toBe("calendar");
  });

  it("matches German view navigation commands", () => {
    expect(matchViewCommand("öffne einstellungen")).toBe("settings");
    expect(matchViewCommand("zeige meinen kalender")).toBe("calendar");
  });

  it("matches Chinese view navigation commands", () => {
    expect(matchViewCommand("打开设置")).toBe("settings");
    expect(matchViewCommand("查看日历")).toBe("calendar");
    expect(matchViewCommand("切换到钱包")).toBe("wallet");
  });

  it("matches Japanese view navigation commands", () => {
    expect(matchViewCommand("設定を開いて")).toBe("settings");
    expect(matchViewCommand("カレンダーを表示")).toBe("calendar");
  });

  it("matches Korean view navigation commands", () => {
    expect(matchViewCommand("설정 열기")).toBe("settings");
    expect(matchViewCommand("캘린더 보여줘")).toBe("calendar");
  });

  it("rejects negated navigation commands", () => {
    expect(matchViewCommand("don't open settings")).toBeNull();
    expect(matchViewCommand("do not go to calendar")).toBeNull();
    expect(matchViewCommand("no abras ajustes")).toBeNull();
  });

  it("rejects companion action requests", () => {
    expect(matchViewCommand("draw avatar dance")).toBeNull();
    expect(matchViewCommand("generate companion emote")).toBeNull();
  });

  it("rejects oversized inputs and nullish values", () => {
    expect(matchViewCommand("a".repeat(161))).toBeNull();
    expect(matchViewCommand("")).toBeNull();
    expect(matchViewCommand("   ")).toBeNull();
    expect(matchViewCommand(null)).toBeNull();
    expect(matchViewCommand(undefined)).toBeNull();
    expect(matchViewCommand(123 as unknown as string)).toBeNull();
  });
});

describe("MATCHER_VIEW_IDS", () => {
  it("contains core platform view identifiers", () => {
    expect(MATCHER_VIEW_IDS).toContain("settings");
    expect(MATCHER_VIEW_IDS).toContain("calendar");
    expect(MATCHER_VIEW_IDS).toContain("inbox");
    expect(MATCHER_VIEW_IDS).toContain("wallet");
    expect(MATCHER_VIEW_IDS).toContain("chat");
  });
});
