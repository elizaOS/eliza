'use client';

import { Reply } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Message } from './types';

const LONG_PRESS_THRESHOLD_MS = 500;

interface MessageContextMenuProps {
  message: Message;
  onReply: (message: Message) => void;
  children: React.ReactNode;
}

/**
 * Context menu for chat messages.
 *
 * Desktop: right-click opens a Radix ContextMenu.
 * Mobile: long-press opens a DropdownMenu (since Radix ContextMenu doesn't
 * reliably support touch events on all mobile browsers).
 */
export function MessageContextMenu({
  message,
  onReply,
  children,
}: MessageContextMenuProps) {
  // Don't show context menu for thinking placeholders
  if (message.isThinking) {
    return <>{children}</>;
  }

  return (
    <>
      {/* Desktop: Radix ContextMenu (right-click) */}
      <div className="hidden md:contents">
        <DesktopContextMenu message={message} onReply={onReply}>
          {children}
        </DesktopContextMenu>
      </div>

      {/* Mobile: long-press with dropdown */}
      <div className="contents md:hidden">
        <MobileLongPressMenu message={message} onReply={onReply}>
          {children}
        </MobileLongPressMenu>
      </div>
    </>
  );
}

function DesktopContextMenu({
  message,
  onReply,
  children,
}: MessageContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onReply(message)}>
          <Reply className="h-4 w-4" />
          <span>Reply</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MobileLongPressMenu({
  message,
  onReply,
  children,
}: MessageContextMenuProps) {
  const [open, setOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const clearTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Clean up timer on unmount to prevent setState on unmounted component
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  const handleTouchStart = useCallback(() => {
    didLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      setOpen(true);
    }, LONG_PRESS_THRESHOLD_MS);
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      clearTimer();
      // Prevent click if we triggered a long press
      if (didLongPress.current) {
        e.preventDefault();
      }
    },
    [clearTimer]
  );

  const handleTouchMove = useCallback(() => {
    // Cancel long press if finger moves (user is scrolling)
    clearTimer();
  }, [clearTimer]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <div
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchMove}
          className="select-none"
        >
          {children}
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onClick={() => {
            onReply(message);
            setOpen(false);
          }}
        >
          <Reply className="h-4 w-4" />
          <span>Reply</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
