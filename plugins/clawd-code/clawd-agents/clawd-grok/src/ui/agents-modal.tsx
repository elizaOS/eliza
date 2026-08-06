import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { type RefObject, useEffect, useRef } from "react";
import { MODELS } from "../grok/models";
import type { CustomSubagentConfig } from "../utils/settings";
import { formatSubagentName } from "../utils/subagent-display";
import type { Theme } from "./theme";

const EDITOR_KEYBINDINGS = [{ name: "return", action: "submit" as const }];

export type SubagentBrowseRow = { kind: "agent"; agent: CustomSubagentConfig };
export const SUBAGENT_EDITOR_FIELDS = ["name", "model", "instruction"] as const;
export type SubagentEditorField = (typeof SUBAGENT_EDITOR_FIELDS)[number];

export function buildSubagentBrowseRows(agents: CustomSubagentConfig[], query: string): SubagentBrowseRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? agents.filter(
        (agent) =>
          agent.name.toLowerCase().includes(q) ||
          agent.model.toLowerCase().includes(q) ||
          agent.instruction.toLowerCase().includes(q),
      )
    : agents;

  return filtered.map((agent) => ({ kind: "agent" as const, agent }));
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

function syncRef(ref: RefObject<TextareaRenderable | null>, value: string): void {
  ref.current?.clear();
  if (value) {
    ref.current?.insertText(value);
  }
}

export function SubagentsBrowserModal({
  t,
  width,
  height,
  selectedIndex,
  searchQuery,
  rows,
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  searchQuery: string;
  rows: SubagentBrowseRow[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;

    listRef.current?.scrollChildIntoView(`subagent-${selected.agent.name}`);
  }, [rows, selectedIndex]);

  const itemCount = Math.max(rows.length, 1);
  const contentHeight = itemCount + 8;
  const panelHeight = Math.min(contentHeight, Math.floor(height * 0.6));
  const panelWidth = Math.min(60, width - 6);
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={bottomAlignedModalTop(height, panelHeight)}
      backgroundColor={overlayBg}
    >
      <box
        width={panelWidth}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Custom sub-agents"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>
            {searchQuery || <span style={{ fg: t.textMuted }}>{"Search by name, model..."}</span>}
          </text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.map((row, idx) => {
            const selected = idx === selectedIndex;

            return (
              <box
                key={`agent-${row.agent.name}`}
                id={`subagent-${row.agent.name}`}
                width="100%"
                backgroundColor={selected ? t.selectedBg : undefined}
                paddingLeft={2}
                paddingRight={2}
              >
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={selected ? t.primary : t.text}>
                    <b>{formatSubagentName(row.agent.name)}</b>
                  </text>
                  <text fg={t.textMuted}>{row.agent.model}</text>
                </box>
              </box>
            );
          })}
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted}>{"No custom sub-agents yet"}</text>
            </box>
          ) : null}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"open selected · "}</span>
            <span style={{ fg: t.primary }}>{"ctrl+a "}</span>
            <span style={{ fg: t.textMuted }}>{"add"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

export function SubagentEditorModal({
  t,
  width,
  height,
  draft,
  focusedField,
  modelIndex,
  error,
  title,
  nameRef,
  instructionRef,
  onSubmit,
  showRemoveHint,
}: {
  t: Theme;
  width: number;
  height: number;
  draft: { name: string; instruction: string };
  focusedField: SubagentEditorField;
  modelIndex: number;
  error: string | null;
  title: string;
  nameRef: RefObject<TextareaRenderable | null>;
  instructionRef: RefObject<TextareaRenderable | null>;
  onSubmit: () => void;
  showRemoveHint?: boolean;
}) {
  const model = MODELS[modelIndex] ?? MODELS[0];
  const panelWidth = Math.min(68, width - 6);
  const panelHeight = Math.min(28, Math.floor(height * 0.75));
  const overlayBg = "#000000cc" as string;

  useEffect(() => {
    syncRef(nameRef, draft.name);
    syncRef(instructionRef, draft.instruction);
  }, [draft, nameRef, instructionRef]);

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={bottomAlignedModalTop(height, panelHeight)}
      backgroundColor={overlayBg}
    >
      <box
        width={panelWidth}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{title}</b>
          </text>
          <text fg={t.textMuted}>{"esc back"}</text>
        </box>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <box paddingBottom={1}>
            <text fg={focusedField === "name" ? t.primary : t.textMuted}>{"Name (task tool agent value)"}</text>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
              <textarea
                ref={nameRef}
                focused={focusedField === "name"}
                placeholder="e.g. security-review"
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={1}
                maxHeight={2}
                wrapMode="word"
                keyBindings={EDITOR_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
              />
            </box>
          </box>
          <box paddingBottom={1}>
            <text fg={focusedField === "model" ? t.primary : t.textMuted}>
              {"Model - "}
              <span style={{ fg: t.text }}>{`${model.name} (${model.id})`}</span>
            </text>
            {focusedField === "model" ? <text fg={t.textMuted}>{"up/down or left/right to change model"}</text> : null}
          </box>
          <box paddingBottom={1}>
            <text fg={focusedField === "instruction" ? t.primary : t.textMuted}>{"Instruction (system prompt)"}</text>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
              <textarea
                ref={instructionRef}
                focused={focusedField === "instruction"}
                placeholder="How this sub-agent should behave..."
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={4}
                maxHeight={12}
                wrapMode="word"
                keyBindings={EDITOR_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
              />
            </box>
          </box>
          {error ? (
            <box paddingBottom={1}>
              <text fg={t.diffRemovedFg}>{error}</text>
            </box>
          ) : null}
        </scrollbox>
        <box
          flexShrink={0}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
          gap={0}
        >
          {showRemoveHint ? (
            <text>
              <span style={{ fg: t.primary }}>{"ctrl+x "}</span>
              <span style={{ fg: t.textMuted }}>{"remove sub-agent"}</span>
            </text>
          ) : null}
          <text fg={t.textMuted}>{"tab fields · enter save"}</text>
        </box>
      </box>
    </box>
  );
}
