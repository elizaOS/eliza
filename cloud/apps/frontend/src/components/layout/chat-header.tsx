/**
 * Chat header component for the /chat page.
 * Supports switching to build mode and sidebar toggle.
 *
 * @param props - Chat header configuration
 * @param props.onToggleSidebar - Optional callback to toggle sidebar visibility
 */

"use client";

import { BrandButton } from "@elizaos/cloud-ui/components/brand/brand-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@elizaos/cloud-ui/components/dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  GitFork,
  Globe,
  Link2,
  Lock,
  Menu,
  MessageSquare,
  Plus,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { useChatStore } from "@/lib/stores/chat-store";
import { cn } from "@/lib/utils";
import { ElizaAvatar } from "../chat/eliza-avatar";

// ==========================================================================
// SHARED COMPONENTS (defined at module scope to prevent re-creation on render)
// ==========================================================================

interface AgentDisplayProps {
  agent:
    | {
        id: string;
        name: string;
        avatarUrl?: string | null;
        username?: string | null;
        creatorUsername?: string | null;
      }
    | undefined;
  showCreatorAttribution?: boolean;
}

// Shared agent display component used in both static display and owner picker
function AgentDisplay({ agent, showCreatorAttribution = false }: AgentDisplayProps) {
  if (!agent) {
    return <span className="text-sm text-white/60">No agent selected</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <ElizaAvatar
        avatarUrl={agent.avatarUrl || undefined}
        name={agent.name}
        className="w-6 h-6"
        iconClassName="h-3 w-3"
        fallbackClassName="bg-[#FF5800]"
        data-testid="agent-avatar"
      />
      <div className="flex flex-col items-start">
        <span className="text-sm font-medium text-white">{agent.name}</span>
        {agent.username && <span className="text-xs text-white/60">@{agent.username}</span>}
      </div>
      {/* Creator attribution for non-owners */}
      {showCreatorAttribution && agent.creatorUsername && (
        <span className="text-xs text-white/40 ml-2" data-testid="creator-attribution">
          by @{agent.creatorUsername}
        </span>
      )}
    </div>
  );
}

interface CopyLinkButtonProps {
  copied: boolean;
  onCopyShareLink: () => void;
}

// Shared copy link button component used in non-owner and unauthenticated controls
function CopyLinkButton({ copied, onCopyShareLink }: CopyLinkButtonProps) {
  return (
    <button
      onClick={onCopyShareLink}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-none transition-colors",
        "border border-white/10 bg-black/40 hover:bg-white/5",
        "text-white/80 hover:text-white",
      )}
      data-testid="copy-link-btn"
    >
      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Link2 className="h-4 w-4" />}
      <span className="hidden md:inline">{copied ? "Copied!" : "Share"}</span>
    </button>
  );
}

interface ChatHeaderProps {
  onToggleSidebar?: () => void;
}

export function ChatHeader({ onToggleSidebar }: ChatHeaderProps) {
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const { authenticated: isAuthenticated } = useSessionAuth();
  const {
    selectedCharacterId,
    setSelectedCharacterId,
    setRoomId,
    rooms,
    availableCharacters,
    viewerState,
  } = useChatStore();

  // Share status state (only fetched for owners)
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);

  // Derive mode from pathname
  const mode = pathname.includes("/build") ? "build" : "chat";
  const isBuildPage = mode === "build";

  // Find selected agent
  const selectedAgent = availableCharacters.find((a) => a.id === selectedCharacterId);

  // Determine if user is the owner of the selected character
  const isOwner = viewerState === "owner";

  // Fetch share status when character changes (only for owners)
  useEffect(() => {
    if (!selectedCharacterId || !isOwner) {
      setIsPublic(null);
      return;
    }

    const controller = new AbortController();

    const fetchShareStatus = async () => {
      try {
        const res = await fetch(`/api/my-agents/characters/${selectedCharacterId}/share`, {
          signal: controller.signal,
        });

        if (res.status === 403 || res.status === 404) {
          setIsPublic(null);
          return;
        }

        if (!res.ok) {
          setIsPublic(null);
          return;
        }

        const data = await res.json();
        if (data?.success) {
          setIsPublic(data.data.isPublic);
        } else {
          setIsPublic(null);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setIsPublic(null);
      }
    };

    fetchShareStatus();

    return () => {
      controller.abort();
    };
  }, [selectedCharacterId, isOwner]);

  // Copy share link to clipboard
  // Uses the @username URL format when available for cleaner, more shareable links
  const handleCopyShareLink = async () => {
    if (!selectedCharacterId) return;

    const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
    // Prefer username-based URL for public sharing (cleaner and works for non-auth users)
    const shareUrl = selectedAgent?.username
      ? `${baseUrl}/chat/@${selectedAgent.username}`
      : `${baseUrl}/chat/${selectedCharacterId}`;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success("Share link copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy link");
    }
  };

  // Fork (duplicate) agent to user's account
  const handleCopyAgent = async () => {
    if (!selectedCharacterId || !isAuthenticated) return;

    setIsCopying(true);
    try {
      const response = await fetch(`/api/my-agents/characters/${selectedCharacterId}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const data = await response.json();
      const clonedId = data.data?.character?.id;
      if (data.success && clonedId) {
        toast.success(`Forked "${selectedAgent?.name}" to your account!`);
        navigate(`/dashboard/chat?characterId=${clonedId}`);
      } else {
        toast.error(data.error || "Failed to fork agent");
      }
    } catch {
      toast.error("Failed to fork agent");
    } finally {
      setIsCopying(false);
    }
  };

  // Toggle share status (owner only)
  const handleToggleShare = async () => {
    if (!selectedCharacterId || !isOwner) return;

    try {
      const response = await fetch(`/api/my-agents/characters/${selectedCharacterId}/share`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: !isPublic }),
      });

      const data = await response.json();
      if (data.success) {
        setIsPublic(data.data.isPublic);
        toast.success(data.data.message);
      } else {
        toast.error(data.error || "Failed to update sharing");
      }
    } catch {
      toast.error("Failed to update sharing");
    }
  };

  const handleAgentChange = (characterId: string) => {
    setSelectedCharacterId(characterId);

    const params = new URLSearchParams();
    params.set("characterId", characterId);

    // Only handle room selection when in chat mode
    if (mode === "chat") {
      const characterRooms = rooms
        .filter((room) => room.characterId === characterId)
        .sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));

      if (characterRooms.length > 0) {
        const mostRecentRoom = characterRooms[0];
        setRoomId(mostRecentRoom.id);
        params.set("roomId", mostRecentRoom.id);
      } else {
        setRoomId(null);
      }
    } else {
      setRoomId(null);
    }

    const path = mode === "build" ? "/dashboard/build" : "/dashboard/chat";
    navigate(`${path}?${params.toString()}`);
  };

  const handleCreateNewAgent = () => {
    setSelectedCharacterId(null);
    setRoomId(null);
    navigate("/dashboard/build");
  };

  const handleModeChange = (newMode: "chat" | "build") => {
    if (newMode === mode) return;
    if (newMode === "chat" && !selectedCharacterId) return;

    const params = new URLSearchParams();
    if (selectedCharacterId) {
      params.set("characterId", selectedCharacterId);

      // When switching to chat mode, open most recent conversation if one exists
      if (newMode === "chat") {
        const characterRooms = rooms
          .filter((room) => room.characterId === selectedCharacterId)
          .sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));

        if (characterRooms.length > 0) {
          const mostRecentRoom = characterRooms[0];
          setRoomId(mostRecentRoom.id);
          params.set("roomId", mostRecentRoom.id);
        }
      }
    }

    const path = newMode === "build" ? "/dashboard/build" : "/dashboard/chat";
    const url = params.toString() ? `${path}?${params.toString()}` : path;
    navigate(url);
  };

  // ==========================================================================
  // RENDER: Static Agent Display (for non-owners and unauthenticated)
  // ==========================================================================
  const renderStaticAgentDisplay = () => (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-none",
        "border border-white/10 bg-black/40",
      )}
      data-testid="agent-name"
    >
      <AgentDisplay agent={selectedAgent} showCreatorAttribution={viewerState === "non-owner"} />
    </div>
  );

  // ==========================================================================
  // RENDER: Owner Agent Picker Dropdown
  // ==========================================================================
  const renderOwnerAgentPicker = () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-none",
            "border border-white/10 bg-black/40",
            "hover:bg-white/5 transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-[#FF5800]/50",
          )}
          data-testid="agent-picker-dropdown"
        >
          {selectedAgent ? (
            <>
              <AgentDisplay agent={selectedAgent} />
              <ChevronDown className="h-4 w-4 text-white/60" />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-[#FF5800]/20 border border-[#FF5800]/30 flex items-center justify-center">
                  <Plus className="h-3 w-3 text-[#FF5800]" />
                </div>
                <span className="text-sm text-white">Create New Agent</span>
              </div>
              <ChevronDown className="h-4 w-4 text-white/60" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 bg-[#0A0A0A] border-white/10">
        <DropdownMenuItem
          onClick={handleCreateNewAgent}
          className={cn(
            "flex items-center gap-2 px-3 py-2 cursor-pointer",
            "hover:bg-white/5 focus:bg-white/5",
          )}
        >
          <div className="w-6 h-6 rounded-full bg-[#FF5800]/20 border border-[#FF5800]/30 flex items-center justify-center">
            <Plus className="h-3 w-3 text-[#FF5800]" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-white">Create New Agent</span>
          </div>
        </DropdownMenuItem>

        {availableCharacters.length > 0 && (
          <>
            <div className="border-t border-white/10 my-1" />
            {availableCharacters.map((character) => (
              <DropdownMenuItem
                key={character.id}
                onClick={() => handleAgentChange(character.id)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 cursor-pointer",
                  "hover:bg-white/5 focus:bg-white/5",
                  selectedCharacterId === character.id && "bg-white/10",
                )}
              >
                <AgentDisplay agent={character} />
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // ==========================================================================
  // RENDER: Owner Controls (Share + Mode Toggle)
  // ==========================================================================
  const renderOwnerControls = () => (
    <div className="flex items-center gap-2">
      {/* Share Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-none transition-colors",
              "border border-white/10 bg-black/40 hover:bg-white/5",
              "focus:outline-none focus:ring-2 focus:ring-[#FF5800]/50",
              isPublic && "border-green-500/30",
            )}
            title={isPublic ? "Public - Anyone can chat" : "Private"}
            data-testid="share-toggle"
          >
            {isPublic ? (
              <Globe className="h-4 w-4 text-green-500" />
            ) : (
              <Lock className="h-4 w-4 text-white/60" />
            )}
            <span className="hidden md:inline text-sm text-white/80">
              {isPublic ? "Public" : "Private"}
            </span>
            <ChevronDown className="h-3 w-3 text-white/40" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 bg-[#0A0A0A] border-white/10">
          <DropdownMenuItem
            onClick={handleToggleShare}
            className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/5"
            data-testid="toggle-visibility"
          >
            {isPublic ? (
              <>
                <Lock className="h-4 w-4 text-white/60" />
                <span className="text-white">Make Private</span>
              </>
            ) : (
              <>
                <Globe className="h-4 w-4 text-green-500" />
                <span className="text-white">Make Public</span>
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-white/10" />
          <DropdownMenuItem
            onClick={handleCopyShareLink}
            className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/5"
            disabled={!isPublic}
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 text-green-500" />
                <span className="text-green-500">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="h-4 w-4 text-white/60" />
                <span className={isPublic ? "text-white" : "text-white/40"}>Copy Share Link</span>
              </>
            )}
          </DropdownMenuItem>
          {!isPublic && (
            <div className="px-3 py-2 text-xs text-white/40">Make your agent public to share</div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mode Toggle */}
      <div className="flex items-center rounded-none border border-white/10 bg-black/40">
        <button
          onClick={() => handleModeChange("chat")}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-none transition-colors border-0",
            mode === "chat"
              ? "bg-[#471E08] text-white"
              : "bg-[#1F1F1F] text-[#ADADAD] hover:text-white",
          )}
          data-testid="chat-mode-btn"
        >
          <MessageSquare className="h-4 w-4" />
          <span className="hidden md:inline">Chat</span>
        </button>
        <button
          onClick={() => handleModeChange("build")}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-none transition-colors border-0",
            mode === "build"
              ? "bg-[#2D1505] text-white"
              : "bg-[#1F1F1F] text-[#ADADAD] hover:text-white",
          )}
          data-testid="edit-mode-btn"
        >
          <Wrench className={cn("h-4 w-4", mode === "build" ? "text-[#FF5800]" : "text-white")} />
          <span className="hidden md:inline">Edit</span>
        </button>
      </div>
    </div>
  );

  // ==========================================================================
  // RENDER: Non-Owner Controls (Chat + Copy Agent + Copy Link)
  // ==========================================================================
  const renderNonOwnerControls = () => (
    <div className="flex items-center gap-2">
      {/* Chat button (always active for non-owners viewing public agent) */}
      <button
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-none transition-colors",
          "border border-white/10 bg-[#471E08] text-white",
        )}
        data-testid="chat-mode-btn"
      >
        <MessageSquare className="h-4 w-4" />
        <span className="hidden md:inline">Chat</span>
      </button>

      {/* Fork Agent button (authenticated non-owners only) */}
      {isAuthenticated && (
        <button
          onClick={handleCopyAgent}
          disabled={isCopying}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-none transition-colors",
            "border border-white/10 bg-black/40 hover:bg-white/5",
            "text-white/80 hover:text-white",
            isCopying && "opacity-50 cursor-not-allowed",
          )}
          data-testid="copy-agent-btn"
        >
          <GitFork className="h-4 w-4" />
          <span className="hidden md:inline">{isCopying ? "Forking..." : "Fork"}</span>
        </button>
      )}

      {/* Copy Link button */}
      <CopyLinkButton copied={copied} onCopyShareLink={handleCopyShareLink} />
    </div>
  );

  // ==========================================================================
  // RENDER: Unauthenticated Controls (Copy Link only)
  // ==========================================================================
  const renderUnauthenticatedControls = () => (
    <div className="flex items-center gap-2">
      {/* Copy Link button */}
      <CopyLinkButton copied={copied} onCopyShareLink={handleCopyShareLink} />
    </div>
  );

  return (
    <header className="flex h-16 items-center justify-between border border-white/10 bg-black/65 px-2 backdrop-blur-3xl md:px-3">
      <div className="flex items-center gap-1.5">
        {/* Mobile Menu Button */}
        {onToggleSidebar && (
          <BrandButton
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={onToggleSidebar}
            aria-label="Toggle navigation"
          >
            <Menu className="h-5 w-5 text-white" />
          </BrandButton>
        )}

        {/* Back to Dashboard - only on build page */}
        {isBuildPage && (
          <Link
            to="/dashboard"
            className="flex items-center justify-center size-10 border border-transparent hover:border-white/10 bg-white/5 text-white/60 hover:text-white hover:bg-white/10 rounded-2xl transition-colors"
            aria-label="Back to dashboard"
          >
            <ChevronLeft className="size-5" />
          </Link>
        )}

        {/* Agent Display: Dropdown for owners OR on build page (allows unauthenticated users to create agents) */}
        {/* On chat page, non-owners see static display with creator attribution */}
        {isOwner || isBuildPage ? renderOwnerAgentPicker() : renderStaticAgentDisplay()}
      </div>

      {/* Right-side Controls - Only show when an agent is selected */}
      {selectedCharacterId && (
        <>
          {isOwner && renderOwnerControls()}
          {viewerState === "non-owner" && renderNonOwnerControls()}
          {viewerState === "unauthenticated" && renderUnauthenticatedControls()}
        </>
      )}
    </header>
  );
}
