import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { useEffect, useState } from "react";
import { COMMON_SHORTCUTS } from "../../hooks";
import { useApp } from "../../state";

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

  const grouped: Record<string, typeof COMMON_SHORTCUTS> = {};
  for (const shortcut of COMMON_SHORTCUTS) {
    const scope = shortcut.scope ?? "global";
    if (!grouped[scope]) {
      grouped[scope] = [];
    }
    grouped[scope].push(shortcut);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg rounded-xl max-h-[80vh] overflow-y-auto p-0">
        <DialogHeader
          className="px-5 py-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <DialogTitle className="text-base font-bold">
            {t("shortcutsoverlay.KeyboardShortcuts")}
          </DialogTitle>
        </DialogHeader>
        <div className="p-5 space-y-5">
          {Object.entries(grouped).map(([scope, shortcuts]) => (
            <div key={scope}>
              <h3
                className="text-xs-tight uppercase tracking-wide font-medium mb-2"
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
                      className="inline-flex items-center gap-0.5 px-2 py-0.5 text-xs-tight font-mono rounded"
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
      </DialogContent>
    </Dialog>
  );
}
