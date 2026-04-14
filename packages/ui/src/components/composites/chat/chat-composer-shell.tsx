import type * as React from "react";

import { cn } from "../../../lib/utils";
import type { ChatVariant } from "./chat-types";

export interface ChatComposerShellProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  before?: React.ReactNode;
  children: React.ReactNode;
  shellRef?: React.Ref<HTMLDivElement>;
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
        ref={shellRef}
        className={cn(
          "mt-auto pointer-events-auto px-1 max-[380px]:px-0.5",
          className,
        )}
        data-no-camera-drag="true"
        style={{
          zIndex: 1,
          paddingBottom:
            "calc(max(env(safe-area-inset-bottom, 0px), 0px) + 0.25rem)",
          ...style,
        }}
        {...props}
      >
        {before}
        <div className="relative flex items-center px-3 py-2 max-[380px]:min-h-[78px] max-[380px]:px-2.5 max-[380px]:py-1.5">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full border border-border/26 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_72%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_20px_52px_rgba(15,23,42,0.18)] ring-1 ring-inset ring-white/8 backdrop-blur-[22px] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_24px_58px_rgba(0,0,0,0.36)]"
          />
          <div className="relative z-[1] flex w-full items-center">
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className={cn(
        "relative bg-transparent px-3 pb-3 pt-3 sm:px-4 sm:pb-4 xl:px-5",
        className,
      )}
      style={{
        zIndex: 1,
        paddingBottom: "calc(var(--safe-area-bottom, 0px) + 0.75rem)",
        ...style,
      }}
      {...props}
    >
      {before}
      {children}
    </div>
  );
}
