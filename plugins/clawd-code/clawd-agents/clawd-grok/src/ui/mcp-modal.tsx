import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { type RefObject, useEffect, useRef } from "react";
import type { McpCatalogEntry } from "../mcp/catalog";
import { toMcpServerId } from "../mcp/validate";
import type { McpServerConfig } from "../utils/settings";
import type { McpBrowserRow, McpEditorDraft, McpEditorField } from "./mcp-modal-types";
import type { Theme } from "./theme";

const EDITOR_KEYBINDINGS = [{ name: "return", action: "submit" as const }];

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function buildMcpBrowseRows(
  servers: McpServerConfig[],
  catalog: McpCatalogEntry[],
  query: string,
): McpBrowserRow[] {
  const q = query.trim().toLowerCase();
  const catalogById = new Map(catalog.map((entry) => [toMcpServerId(entry.id), entry] as const));
  const filteredServers = q
    ? servers.filter(
        (server) =>
          server.label.toLowerCase().includes(q) ||
          server.id.toLowerCase().includes(q) ||
          server.transport.toLowerCase().includes(q),
      )
    : servers;
  const savedIds = new Set(servers.map((server) => toMcpServerId(server.id || server.label)));
  const filteredCatalog = (
    q
      ? catalog.filter(
          (entry) =>
            entry.name.toLowerCase().includes(q) ||
            entry.id.toLowerCase().includes(q) ||
            entry.description.toLowerCase().includes(q),
        )
      : catalog
  ).filter((entry) => !savedIds.has(toMcpServerId(entry.id)));

  return [
    ...filteredServers.map((server) => {
      const catalogEntry = catalogById.get(toMcpServerId(server.id || server.label));
      return {
        kind: "server",
        server,
        description: catalogEntry?.description ?? "Custom MCP server",
      } satisfies McpBrowserRow;
    }),
    ...filteredCatalog.map((entry) => ({ kind: "catalog", entry }) satisfies McpBrowserRow),
    { kind: "add" },
  ];
}

export function McpBrowserModal({
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
  rows: McpBrowserRow[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;

    if (selected.kind === "server") {
      listRef.current?.scrollChildIntoView(`mcp-server-${selected.server.id}`);
    } else if (selected.kind === "catalog") {
      listRef.current?.scrollChildIntoView(`mcp-catalog-${selected.entry.id}`);
    } else {
      listRef.current?.scrollChildIntoView("mcp-add");
    }
  }, [rows, selectedIndex]);

  const itemCount = Math.max(rows.length, 1);
  const contentHeight = itemCount + 7;
  const maxHeight = Math.floor(height * 0.68);
  const panelHeight = Math.min(contentHeight, maxHeight);
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
        width={Math.min(96, width - 4)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"MCP Servers"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>{searchQuery || <span style={{ fg: t.textMuted }}>{"Search servers..."}</span>}</text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.map((row, idx) => {
            const selected = idx === selectedIndex;

            if (row.kind === "server") {
              const enabledColor = row.server.enabled ? t.diffAddedFg : selected ? t.selected : t.text;
              return (
                <box
                  key={`server-${row.server.id}`}
                  id={`mcp-server-${row.server.id}`}
                  backgroundColor={selected ? t.selectedBg : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={enabledColor}>
                      {row.server.enabled ? "■ " : "□ "}
                      {row.server.label}
                    </text>
                    <text fg={row.server.enabled ? t.diffAddedFg : t.textMuted}>{row.server.transport}</text>
                  </box>
                  <text fg={t.textMuted}>{row.description}</text>
                </box>
              );
            }

            if (row.kind === "catalog") {
              return (
                <box
                  key={`catalog-${row.entry.id}`}
                  id={`mcp-catalog-${row.entry.id}`}
                  backgroundColor={selected ? t.selectedBg : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={selected ? t.selected : t.text}>
                      {"□ "}
                      {row.entry.name}
                    </text>
                    <text fg={t.textMuted}>{"Popular"}</text>
                  </box>
                  <text fg={t.textMuted}>{row.entry.description}</text>
                </box>
              );
            }

            return (
              <box
                key="mcp-add"
                id="mcp-add"
                backgroundColor={selected ? t.selectedBg : undefined}
                paddingLeft={2}
                paddingRight={2}
              >
                <text fg={selected ? t.selected : t.primary}>
                  <b>{"□ Add Custom MCP"}</b>
                </text>
              </box>
            );
          })}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"toggle  ·  "}</span>
            <span style={{ fg: t.primary }}>{"ctrl+e "}</span>
            <span style={{ fg: t.textMuted }}>{"edit  ·  "}</span>
            <span style={{ fg: t.primary }}>{"ctrl+a "}</span>
            <span style={{ fg: t.textMuted }}>{"add  ·  "}</span>
            <span style={{ fg: t.primary }}>{"ctrl+x "}</span>
            <span style={{ fg: t.textMuted }}>{"delete"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

function syncRef(ref: RefObject<TextareaRenderable | null>, value: string): void {
  ref.current?.clear();
  if (value) {
    ref.current?.insertText(value);
  }
}

export function McpEditorModal({
  t,
  width,
  height,
  draft,
  focusedField,
  syncKey,
  error,
  title,
  labelRef,
  urlRef,
  headersRef,
  commandRef,
  argsRef,
  cwdRef,
  envRef,
  onSubmit,
}: {
  t: Theme;
  width: number;
  height: number;
  draft: McpEditorDraft;
  focusedField: McpEditorField;
  syncKey: number;
  error: string | null;
  title: string;
  labelRef: RefObject<TextareaRenderable | null>;
  urlRef: RefObject<TextareaRenderable | null>;
  headersRef: RefObject<TextareaRenderable | null>;
  commandRef: RefObject<TextareaRenderable | null>;
  argsRef: RefObject<TextareaRenderable | null>;
  cwdRef: RefObject<TextareaRenderable | null>;
  envRef: RefObject<TextareaRenderable | null>;
  onSubmit: () => void;
}) {
  const panelHeight = Math.min(30, Math.floor(height * 0.82));
  const overlayBg = "#000000cc" as string;
  const isRemote = draft.transport === "http" || draft.transport === "sse";

  // biome-ignore lint/correctness/useExhaustiveDependencies: syncKey is an intentional cache-bust prop
  useEffect(() => {
    syncRef(labelRef, draft.label);
    syncRef(urlRef, draft.url);
    syncRef(headersRef, draft.headersText);
    syncRef(commandRef, draft.command);
    syncRef(argsRef, draft.argsText);
    syncRef(cwdRef, draft.cwd);
    syncRef(envRef, draft.envText);
  }, [draft, syncKey, labelRef, urlRef, headersRef, commandRef, argsRef, cwdRef, envRef]);

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
        width={Math.min(86, width - 6)}
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
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={focusedField === "transport" ? t.primary : t.textMuted}>{"Transport"}</text>
            {(["stdio", "http", "sse"] as const).map((option) => {
              const active = draft.transport === option;
              const focused = focusedField === "transport";
              return (
                <box
                  key={option}
                  backgroundColor={active ? (focused ? t.selectedBg : t.backgroundElement) : undefined}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={active ? (focused ? t.primary : t.text) : t.textMuted}>{option}</text>
                </box>
              );
            })}
          </box>
        </box>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <box paddingBottom={1}>
            <text fg={focusedField === "label" ? t.primary : t.textMuted}>{"Label"}</text>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
              <textarea
                ref={labelRef}
                focused={focusedField === "label"}
                placeholder="GitHub MCP"
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

          {isRemote ? (
            <>
              <box paddingBottom={1}>
                <text fg={focusedField === "url" ? t.primary : t.textMuted}>{"URL"}</text>
                <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
                  <textarea
                    ref={urlRef}
                    focused={focusedField === "url"}
                    placeholder="https://example.com/mcp"
                    textColor={t.text}
                    backgroundColor={t.backgroundElement}
                    placeholderColor={t.textMuted}
                    minHeight={1}
                    maxHeight={3}
                    wrapMode="word"
                    keyBindings={EDITOR_KEYBINDINGS}
                    onSubmit={onSubmit as unknown as () => void}
                  />
                </box>
              </box>
              <box paddingBottom={1}>
                <text fg={focusedField === "headers" ? t.primary : t.textMuted}>
                  {"Headers (one Header: value per line)"}
                </text>
                <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
                  <textarea
                    ref={headersRef}
                    focused={focusedField === "headers"}
                    placeholder="Authorization: Bearer ..."
                    textColor={t.text}
                    backgroundColor={t.backgroundElement}
                    placeholderColor={t.textMuted}
                    minHeight={2}
                    maxHeight={6}
                    wrapMode="word"
                    keyBindings={EDITOR_KEYBINDINGS}
                    onSubmit={onSubmit as unknown as () => void}
                  />
                </box>
              </box>
            </>
          ) : (
            <>
              <box paddingBottom={1}>
                <text fg={focusedField === "command" ? t.primary : t.textMuted}>{"Command"}</text>
                <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
                  <textarea
                    ref={commandRef}
                    focused={focusedField === "command"}
                    placeholder="npx"
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
                <text fg={focusedField === "args" ? t.primary : t.textMuted}>{"Arguments (one per line)"}</text>
                <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
                  <textarea
                    ref={argsRef}
                    focused={focusedField === "args"}
                    placeholder={"-y\n@scope/server"}
                    textColor={t.text}
                    backgroundColor={t.backgroundElement}
                    placeholderColor={t.textMuted}
                    minHeight={2}
                    maxHeight={6}
                    wrapMode="word"
                    keyBindings={EDITOR_KEYBINDINGS}
                    onSubmit={onSubmit as unknown as () => void}
                  />
                </box>
              </box>
              <box paddingBottom={1}>
                <text fg={focusedField === "cwd" ? t.primary : t.textMuted}>{"Working Directory (optional)"}</text>
                <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
                  <textarea
                    ref={cwdRef}
                    focused={focusedField === "cwd"}
                    placeholder="/path/to/project"
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
            </>
          )}

          <box paddingBottom={1}>
            <text fg={focusedField === "env" ? t.primary : t.textMuted}>{"Extra Env (one KEY=value per line)"}</text>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1}>
              <textarea
                ref={envRef}
                focused={focusedField === "env"}
                placeholder="API_KEY=..."
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={2}
                maxHeight={6}
                wrapMode="word"
                keyBindings={EDITOR_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
              />
            </box>
          </box>
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          {error ? (
            <text fg={t.diffRemovedFg}>{error}</text>
          ) : (
            <text>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"save  ·  "}</span>
              <span style={{ fg: t.primary }}>{"tab "}</span>
              <span style={{ fg: t.textMuted }}>{"next field  ·  "}</span>
              <span style={{ fg: t.primary }}>{"←→ "}</span>
              <span style={{ fg: t.textMuted }}>{"transport"}</span>
            </text>
          )}
        </box>
      </box>
    </box>
  );
}
