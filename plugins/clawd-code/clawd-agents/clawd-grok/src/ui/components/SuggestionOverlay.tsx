import type { Theme } from "../theme.js";

const MAX_VISIBLE = 8;

export function SuggestionOverlay({
  t,
  suggestions,
  selectedIndex,
}: {
  t: Theme;
  suggestions: string[];
  selectedIndex: number;
}) {
  if (suggestions.length === 0) return null;

  const visible = suggestions.slice(0, MAX_VISIBLE);

  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
      {visible.map((filePath, i) => {
        const isSelected = i === selectedIndex;
        return (
          <box
            key={filePath}
            height={1}
            backgroundColor={isSelected ? t.selectedBg : undefined}
            flexDirection="row"
            gap={1}
          >
            <text fg={isSelected ? t.accent : t.textDim}>{isSelected ? "›" : " "}</text>
            <text fg={isSelected ? t.selected : t.text}>{filePath}</text>
          </box>
        );
      })}
      {suggestions.length > MAX_VISIBLE && <text fg={t.textDim}>{`  +${suggestions.length - MAX_VISIBLE} more`}</text>}
    </box>
  );
}
