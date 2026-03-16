import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { COMMON_SHORTCUTS } from "../hooks";
import { useApp } from "../state";

function formatKey(shortcut: (typeof COMMON_SHORTCUTS)[number]): string {
  const isMac =
    typeof navigator !== "undefined" && navigator.platform?.includes("Mac");
  const parts: string[] = [];
  if (shortcut.ctrl) {
    parts.push(isMac ? "\u2318" : "Ctrl");
  }
  if (shortcut.shift) {
    parts.push(isMac ? "\u21E7" : "Shift");
  }
  if (shortcut.alt) {
    parts.push(isMac ? "\u2325" : "Alt");
  }
  if (shortcut.meta) {
    parts.push(isMac ? "\u2318" : "Win");
  }
  parts.push(
    shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key,
  );
  return parts.join(isMac ? "" : "+");
}

export function ShortcutsOverlay() {
  const { t } = useApp();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.shiftKey && event.key === "?") {
        const tag = (event.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          return;
        }
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  if (!open) {
    return null;
  }

  const grouped: Record<string, typeof COMMON_SHORTCUTS> = {};
  for (const shortcut of COMMON_SHORTCUTS) {
    const scope = shortcut.scope ?? "global";
    if (!grouped[scope]) {
      grouped[scope] = [];
    }
    grouped[scope].push(shortcut);
  }

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{
        background: "color-mix(in srgb, var(--bg) 50%, transparent)",
        backdropFilter: "blur(4px)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          setOpen(false);
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      tabIndex={-1}
    >
      <div
        className="rounded-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
        style={{
          background: "color-mix(in srgb, var(--bg) 96%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
          backdropFilter: "blur(24px)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <h2 className="text-base font-bold" style={{ color: "var(--text)" }}>
            {t("shortcutsoverlay.KeyboardShortcuts")}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1 rounded transition-colors"
            style={{ color: "var(--muted)" }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-5">
          {Object.entries(grouped).map(([scope, shortcuts]) => (
            <div key={scope}>
              <h3
                className="text-[11px] uppercase tracking-wide font-medium mb-2"
                style={{ color: "var(--muted)" }}
              >
                {scope}
              </h3>
              <div className="space-y-1">
                {shortcuts.map((shortcut) => (
                  <div
                    key={`${shortcut.key}-${shortcut.description}`}
                    className="flex items-center justify-between py-1.5 px-2 rounded"
                  >
                    <span className="text-sm" style={{ color: "var(--text)" }}>
                      {shortcut.description}
                    </span>
                    <kbd
                      className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[11px] font-mono rounded"
                      style={{
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border)",
                        color: "var(--muted)",
                      }}
                    >
                      {formatKey(shortcut)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
