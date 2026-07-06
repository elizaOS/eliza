/**
 * Renders the composer controls used by the floating chat and launcher shell
 * surfaces.
 */
import { Eye, type LucideIcon, Mic, Send } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * Shared chat-composer icon control. This mirrors the continuous overlay
 * composer idiom: token colors, lucide icons, transparent chrome, and a 44px
 * touch target. State reads through color and opacity instead of a second
 * hand-drawn button dialect.
 */

function iconForControl(icon: "mic" | "send" | "vision"): LucideIcon {
  if (icon === "mic") return Mic;
  if (icon === "vision") return Eye;
  return Send;
}

export function GlassIconButton({
  icon,
  label,
  disabled,
  active,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}: {
  icon: "mic" | "send" | "vision";
  label: string;
  disabled?: boolean;
  /** Mic/vision: reflects recording/capturing state (mic also gets aria-pressed). */
  active?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}): React.JSX.Element {
  const pointerActivatedRef = React.useRef(false);
  const Icon = iconForControl(icon);
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (pointerActivatedRef.current) {
        pointerActivatedRef.current = false;
        return;
      }
      onClick?.(event);
    },
    [onClick],
  );
  const handleMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (onPointerDown || onPointerUp || !onClick) return;
      pointerActivatedRef.current = true;
      onClick(event);
      window.setTimeout(() => {
        pointerActivatedRef.current = false;
      }, 0);
    },
    [onClick, onPointerDown, onPointerUp],
  );

  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      aria-pressed={icon === "mic" ? active : undefined}
      disabled={disabled}
      onClick={handleClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onMouseDown={handleMouseDown}
      className={cn(
        "grid shrink-0 place-items-center bg-transparent p-0 transition-colors hover:bg-transparent",
        active ? "text-accent" : "text-muted-strong hover:text-txt",
        disabled && "opacity-40",
      )}
    >
      <Icon className="h-[26px] w-[26px]" aria-hidden={true} />
    </Button>
  );
}
