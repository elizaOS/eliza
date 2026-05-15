import { useEffect, useRef, useState } from "react";
import { useSystemProvider } from "../../providers/context";

export function ShutdownMenu() {
  const { controls } = useSystemProvider();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocClick(event: MouseEvent) {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="elizaos-shell-shutdown" ref={rootRef}>
      <button
        type="button"
        className="elizaos-shell-indicator elizaos-shell-shutdown-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Power menu"
        title="Power"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span aria-hidden="true">{"⏻"}</span>
      </button>
      {open ? (
        <div role="menu" className="elizaos-shell-shutdown-menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              controls.suspend();
            }}
          >
            Suspend
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              controls.restart();
            }}
          >
            Restart
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              controls.shutdown();
            }}
          >
            Shutdown
          </button>
        </div>
      ) : null}
    </div>
  );
}
