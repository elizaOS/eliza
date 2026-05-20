"use client";

import {
  Ban,
  Flag,
  Loader2,
  MoreHorizontal,
  UserMinus,
  UserPlus,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useMenuPosition } from "@/hooks/useMenuPosition";
import { useSocialTracking } from "@/hooks/usePostHog";
import { getAuthToken } from "@/lib/auth";
import { apiUrl } from "@/utils/api-url";
import { BlockUserModal } from "./BlockUserModal";
import { MuteUserModal } from "./MuteUserModal";
import { ReportModal } from "./ReportModal";

const MENU_HEIGHT = 280;
const MENU_WIDTH = 256;
const MOBILE_BREAKPOINT = 640;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return isMobile;
}

interface ModerationMenuProps {
  targetUserId: string;
  targetUsername?: string;
  targetDisplayName?: string;
  targetProfileImageUrl?: string;
  postId?: string;
  isNPC?: boolean;
  onActionComplete?: () => void;
}

export function ModerationMenu({
  targetUserId,
  targetUsername,
  targetDisplayName,
  targetProfileImageUrl,
  postId,
  isNPC = false,
  onActionComplete,
}: ModerationMenuProps) {
  const { authenticated, user } = useAuth();
  const { trackFollow } = useSocialTracking();
  const isMobile = useIsMobile();
  const [showMenu, setShowMenu] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [showMuteModal, setShowMuteModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isFollowLoading, setIsFollowLoading] = useState(false);
  const [isCheckingFollow, setIsCheckingFollow] = useState(true);
  const [mounted, setMounted] = useState(false);

  const { buttonRef, menuPosition, updatePosition } = useMenuPosition(
    showMenu && !isMobile,
    { menuHeight: MENU_HEIGHT, menuWidth: MENU_WIDTH, padding: 2 },
  );

  // Touch handling for swipe-to-dismiss
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef(0);
  const dragCurrentY = useRef(0);
  const isDragging = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const displayName = targetDisplayName || targetUsername || "User";

  const closeMenu = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setShowMenu(false);
      setIsClosing(false);
    }, 200);
  }, []);

  // Lock body scroll when mobile sheet is open
  useEffect(() => {
    if (showMenu && isMobile) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
    return undefined;
  }, [showMenu, isMobile]);

  // Check follow status when menu opens
  useEffect(() => {
    if (!showMenu || !authenticated || !user) {
      setIsCheckingFollow(false);
      return;
    }

    const abortController = new AbortController();

    const checkFollowStatus = async () => {
      setIsCheckingFollow(true);
      const token = getAuthToken();
      if (!token) {
        setIsCheckingFollow(false);
        return;
      }

      try {
        const encodedIdentifier = encodeURIComponent(targetUserId);
        const response = await fetch(
          apiUrl(`/api/users/${encodedIdentifier}/follow`),
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            signal: abortController.signal,
          },
        );

        if (response.ok) {
          const data = await response.json();
          setIsFollowing(data.isFollowing || false);
        } else {
          setIsFollowing(false);
        }
      } catch (error) {
        if (error instanceof Error && error.name !== "AbortError") {
          setIsFollowing(false);
        }
      }
      if (!abortController.signal.aborted) {
        setIsCheckingFollow(false);
      }
    };

    checkFollowStatus();

    return () => {
      abortController.abort();
    };
  }, [showMenu, authenticated, user, targetUserId]);

  const handleFollow = async () => {
    if (!authenticated || !user) {
      toast.error("Please sign in to follow users");
      return;
    }

    setIsFollowLoading(true);
    const token = getAuthToken();
    if (!token) {
      toast.error("Authentication required");
      setIsFollowLoading(false);
      return;
    }

    const newFollowingState = !isFollowing;
    const method = newFollowingState ? "POST" : "DELETE";

    setIsFollowing(newFollowingState);

    try {
      const encodedIdentifier = encodeURIComponent(targetUserId);
      const response = await fetch(
        apiUrl(`/api/users/${encodedIdentifier}/follow`),
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (response.ok) {
        trackFollow(targetUserId, newFollowingState);
        closeMenu();
      } else {
        setIsFollowing(!newFollowingState);
        const errorData = await response.json();
        const errorMessage =
          typeof errorData?.error === "string"
            ? errorData.error
            : errorData?.error?.message || "Failed to update follow status";
        toast.error(errorMessage);
      }
    } catch {
      setIsFollowing(!newFollowingState);
      toast.error("Network error. Please try again.");
    }

    setIsFollowLoading(false);
  };

  const handleAction = () => {
    setShowMenu(false);
    setIsClosing(false);
    onActionComplete?.();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    dragStartY.current = touch.clientY;
    isDragging.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    const currentY = touch.clientY;
    const diff = currentY - dragStartY.current;
    dragCurrentY.current = diff;

    // Only allow dragging down
    if (diff > 0) {
      isDragging.current = true;
      if (sheetRef.current) {
        sheetRef.current.style.transform = `translateY(${diff}px)`;
      }
    }
  };

  const handleTouchEnd = () => {
    if (isDragging.current && dragCurrentY.current > 80) {
      closeMenu();
    }
    // Reset position
    if (sheetRef.current) {
      sheetRef.current.style.transform = "";
    }
    isDragging.current = false;
    dragCurrentY.current = 0;
  };

  // Menu items definition
  const menuItems = [
    ...(authenticated
      ? [
          {
            key: "follow",
            icon:
              isFollowLoading || isCheckingFollow ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : isFollowing ? (
                <UserMinus className="h-5 w-5 text-muted-foreground" />
              ) : (
                <UserPlus className="h-5 w-5 text-muted-foreground" />
              ),
            label: isCheckingFollow
              ? "Loading..."
              : isFollowing
                ? `Unfollow ${displayName}`
                : `Follow ${displayName}`,
            onClick: handleFollow,
            disabled: isFollowLoading || isCheckingFollow,
            variant: "default" as const,
          },
        ]
      : []),
    {
      key: "mute",
      icon: <VolumeX className="h-5 w-5 text-muted-foreground" />,
      label: `Mute ${displayName}`,
      onClick: () => {
        setShowMenu(false);
        setIsClosing(false);
        setShowMuteModal(true);
      },
      variant: "default" as const,
    },
    {
      key: "block",
      icon: <Ban className="h-5 w-5 text-orange-500" />,
      label: `Block ${displayName}`,
      onClick: () => {
        setShowMenu(false);
        setIsClosing(false);
        setShowBlockModal(true);
      },
      variant: "warning" as const,
    },
    ...(!isNPC
      ? [
          {
            key: "report",
            icon: <Flag className="h-5 w-5 text-red-500" />,
            label: postId ? "Report post" : "Report user",
            onClick: () => {
              setShowMenu(false);
              setIsClosing(false);
              setShowReportModal(true);
            },
            variant: "danger" as const,
          },
        ]
      : []),
  ];

  const renderMenuContent = () => (
    <>
      {menuItems.map((item) => (
        <div key={item.key}>
          <button
            onClick={item.onClick}
            disabled={item.disabled}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60 active:bg-muted disabled:opacity-50"
          >
            {item.icon}
            <span
              className={`font-medium text-[15px] ${
                item.variant === "warning"
                  ? "text-orange-500"
                  : item.variant === "danger"
                    ? "text-red-500"
                    : "text-foreground"
              }`}
            >
              {item.label}
            </span>
          </button>
        </div>
      ))}
    </>
  );

  return (
    <div className="relative">
      {/* Trigger Button */}
      <button
        ref={buttonRef}
        onClick={() => {
          if (!showMenu) {
            updatePosition();
          }
          if (showMenu) {
            closeMenu();
          } else {
            setShowMenu(true);
          }
        }}
        className="-mt-1.5 rounded-full p-1.5 transition-colors hover:bg-muted active:bg-muted/80 sm:mt-0"
        aria-label="More options"
      >
        <MoreHorizontal className="h-[18px] w-[18px] text-muted-foreground" />
      </button>

      {/* Menu Portal */}
      {showMenu &&
        mounted &&
        createPortal(
          isMobile ? (
            /* ── Mobile Bottom Sheet ── */
            <>
              {/* Backdrop */}
              <div
                className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ${
                  isClosing ? "opacity-0" : "opacity-100"
                }`}
                onClick={closeMenu}
              />

              {/* Sheet */}
              <div
                ref={sheetRef}
                className={`fixed inset-x-0 bottom-0 z-50 bg-card pb-safe transition-transform duration-200 ease-out ${
                  isClosing ? "translate-y-full" : "translate-y-0"
                }`}
                style={{ borderRadius: "16px 16px 0 0" }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              >
                {/* Drag Handle */}
                <div className="flex justify-center py-2.5">
                  <div className="h-1 w-9 rounded-full bg-muted-foreground/25" />
                </div>

                {/* Actions */}
                <div className="px-1 pb-1">{renderMenuContent()}</div>

                {/* Cancel Button */}
                <div className="px-4 pt-2 pb-4">
                  <button
                    onClick={closeMenu}
                    className="w-full rounded-xl bg-muted py-3 text-center font-semibold text-[15px] text-foreground transition-colors active:bg-muted/80"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </>
          ) : (
            /* ── Desktop Dropdown ── */
            <>
              {/* Overlay to close */}
              <div className="fixed inset-0 z-40" onClick={closeMenu} />

              {/* Dropdown */}
              <div
                className={`fixed z-50 w-64 overflow-hidden border border-border bg-card shadow-xl transition-all duration-150 ${
                  isClosing ? "scale-95 opacity-0" : "scale-100 opacity-100"
                }`}
                style={{
                  borderRadius: "12px",
                  top: menuPosition.openUpward ? "auto" : menuPosition.top,
                  bottom: menuPosition.openUpward
                    ? menuPosition.windowHeight - menuPosition.top
                    : "auto",
                  left: menuPosition.left,
                  transformOrigin: menuPosition.openUpward
                    ? "bottom right"
                    : "top right",
                }}
              >
                <div>{renderMenuContent()}</div>
              </div>
            </>
          ),
          document.body,
        )}

      {/* Modals */}
      <BlockUserModal
        isOpen={showBlockModal}
        onClose={() => setShowBlockModal(false)}
        targetUserId={targetUserId}
        targetDisplayName={displayName}
        isNPC={isNPC}
        onSuccess={handleAction}
      />

      <MuteUserModal
        isOpen={showMuteModal}
        onClose={() => setShowMuteModal(false)}
        targetUserId={targetUserId}
        targetDisplayName={displayName}
        isNPC={isNPC}
        onSuccess={handleAction}
      />

      {!isNPC && (
        <ReportModal
          isOpen={showReportModal}
          onClose={() => setShowReportModal(false)}
          targetUserId={targetUserId}
          targetUsername={targetUsername}
          targetDisplayName={displayName}
          targetProfileImageUrl={targetProfileImageUrl}
          postId={postId}
          onSuccess={handleAction}
        />
      )}
    </div>
  );
}
