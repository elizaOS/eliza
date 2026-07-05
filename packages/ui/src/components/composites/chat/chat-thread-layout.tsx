/**
 * Layout scaffold for a chat thread: a scrolling messages region above a fixed
 * composer, with a footer stack slot. Reserves bottom space equal to
 * `composerHeight` so the last message never hides behind the composer, and
 * carries the game-modal spacing variant. Consumed by ChatView.
 */
import * as React from "react";

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

export interface ChatThreadLayoutProps
  extends React.HTMLAttributes<HTMLElement> {
  composerHeight?: number;
  composer?: React.ReactNode;
  footerStack?: React.ReactNode;
  gameModalComposerGapPx?: number;
  gameModalMessageBottomFallback?: string;
  gameModalMessageTop?: string;
  imageDragOver?: boolean;
  messagesClassName?: string;
  messagesRef?: RefLike<HTMLDivElement>;
  messagesStyle?: React.CSSProperties;
  messagesTestId?: string;
  variant?: ChatVariant;
}

export const ChatThreadLayout = React.forwardRef<
  HTMLElement,
  ChatThreadLayoutProps
>(function ChatThreadLayout(
  {
    children,
    className,
    composerHeight = 0,
    composer,
    footerStack,
    gameModalComposerGapPx = 18,
    gameModalMessageBottomFallback = "5.25rem",
    gameModalMessageTop = "calc(-100% + 1.5rem)",
    imageDragOver: _imageDragOver = false,
    messagesClassName,
    messagesRef,
    messagesStyle,
    messagesTestId = "chat-messages-scroll",
    variant = "default",
    ...props
  },
  ref,
) {
  const isGameModal = variant === "game-modal";
  // overflowAnchor "none": the infinite upward scroll (#13532,
  // useLoadOlderOnScroll) compensates prepends manually (scrollTop += grown
  // height). Browsers with native CSS scroll anchoring (Chrome/Firefox) would
  // ALSO adjust scrollTop for content inserted above the viewport, doubling
  // the shift and shoving the reader one page down per load. Disabling it
  // makes the manual compensation the single owner on every browser (Safari
  // never anchors natively, so it needs the manual path regardless).
  const resolvedMessagesStyle = isGameModal
    ? {
        zIndex: 1,
        overflowAnchor: "none" as const,
        top: gameModalMessageTop,
        bottom:
          composerHeight > 0
            ? `${composerHeight + gameModalComposerGapPx}px`
            : gameModalMessageBottomFallback,
        overscrollBehavior: "contain" as const,
        touchAction: "pan-y" as const,
        userSelect: "text" as const,
        WebkitUserSelect: "text" as const,
        maskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.28) 6%, rgba(0,0,0,0.82) 12%, black 17%, black 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.28) 6%, rgba(0,0,0,0.82) 12%, black 17%, black 100%)",
        ...messagesStyle,
      }
    : {
        zIndex: 1,
        overflowAnchor: "none" as const,
        ...messagesStyle,
      };

  return (
    <section
      ref={ref}
      aria-label="Chat workspace"
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        isGameModal ? "overflow-visible pointer-events-none" : "bg-transparent",
        className,
      )}
      {...props}
    >
      <div
        ref={(node) => assignRef(messagesRef, node)}
        data-testid={messagesTestId}
        data-no-window-drag={false}
        data-no-camera-drag={false}
        data-no-camera-zoom={false}
        className={cn(
          isGameModal
            ? "chat-native-scrollbar absolute inset-x-0 overflow-x-hidden overflow-y-auto pointer-events-auto"
            : "chat-native-scrollbar relative flex flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 py-3 sm:px-4 sm:py-4 xl:px-5",
          messagesClassName,
        )}
        style={resolvedMessagesStyle}
      >
        {children}
      </div>
      {composer}
      {footerStack}
    </section>
  );
});
