import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { StoredSchedule } from "../tools/schedule";
import type { Theme } from "./theme";

export type ScheduleBrowseRow = { kind: "schedule"; schedule: StoredSchedule };

export function buildScheduleBrowseRows(schedules: StoredSchedule[], query: string): ScheduleBrowseRow[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? schedules.filter(
        (schedule) =>
          schedule.name.toLowerCase().includes(q) ||
          schedule.id.toLowerCase().includes(q) ||
          schedule.instruction.toLowerCase().includes(q) ||
          (schedule.cron ?? "").toLowerCase().includes(q),
      )
    : schedules;

  return filtered.map((schedule) => ({ kind: "schedule" as const, schedule }));
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function ScheduleBrowserModal({
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
  rows: ScheduleBrowseRow[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;
    listRef.current?.scrollChildIntoView(`schedule-${selected.schedule.id}`);
  }, [rows, selectedIndex]);

  const itemCount = Math.max(rows.length, 1);
  const contentHeight = itemCount + 10;
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
            <b>{"Schedules"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>
            {searchQuery || <span style={{ fg: t.textMuted }}>{"Search by name, cron, instruction..."}</span>}
          </text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.map((row, idx) => {
            const selected = idx === selectedIndex;
            const schedule = row.schedule;
            const scheduleText = schedule.cron ?? "runs once immediately";
            return (
              <box
                key={`schedule-${schedule.id}`}
                id={`schedule-${schedule.id}`}
                width="100%"
                backgroundColor={selected ? t.selectedBg : undefined}
                paddingLeft={2}
                paddingRight={2}
              >
                <box width="100%" flexDirection="row">
                  <text fg={selected ? t.primary : t.text}>
                    <b>{schedule.name}</b>
                  </text>
                  <text fg={t.textMuted}>{` - ${scheduleText}`}</text>
                </box>
              </box>
            );
          })}
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted}>{"No schedules yet"}</text>
            </box>
          ) : null}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"details · "}</span>
            <span style={{ fg: t.primary }}>{"ctrl+x "}</span>
            <span style={{ fg: t.textMuted }}>{"remove"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}
