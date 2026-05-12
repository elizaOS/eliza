import type * as React from "react";

import { cn } from "../../../lib/utils";
import type { ChatVariant } from "./chat-types";

type RefLike<T> = ((instance: T | null) => void) | { current: T | null } | null;

function assignRef<T>(ref: RefLike<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}

export interface ChatComposerShellProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  before?: React.ReactNode;
  children: React.ReactNode;
  shellRef?: RefLike<HTMLDivElement>;
  variant?: ChatVariant;
}

export function ChatComposerShell({
  before,
  children,
  className,
  shellRef,
  style,
  variant = "default",
  ...props
}: ChatComposerShellProps) {
  if (variant === "game-modal") {
    return (
      <div
        ref={(node) => assignRef(shellRef, node)}
        className={cn(
          "mt-auto pointer-events-auto px-1 max-[380px]:px-0.5",
          className,
        )}
        data-no-camera-drag="true"
        style={{
          zIndex: 1,
          paddingBottom:
            "calc(max(env(safe-area-inset-bottom, 0px), 0px) + var(--eliza-mobile-nav-offset, 0px) + 0.25rem)",
          ...style,
        }}
        {...props}
      >
        {before}
        <div className="relative flex items-center px-3 py-2 max-[380px]:min-h-[78px] max-[380px]:px-2.5 max-[380px]:py-1.5">
          <div className="relative z-[1] flex w-full items-center">
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={(node) => assignRef(shellRef, node)}
      className={cn(
        "relative min-w-0 bg-transparent px-2 pb-3 pt-3 sm:px-6 sm:pb-4 xl:px-14",
        className,
      )}
      style={{
        zIndex: 1,
        paddingBottom:
          "calc(var(--safe-area-bottom, 0px) + var(--eliza-mobile-nav-offset, 0px) + 0.75rem)",
        ...style,
      }}
      {...props}
    >
      {before}
      {children}
    </div>
  );
}
