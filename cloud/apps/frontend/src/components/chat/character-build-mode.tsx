/**
 * Character build mode component with split-pane layout.
 * Combines build mode assistant and character editor in resizable panels.
 * Supports mobile responsive view switching.
 *
 * @param props - Character build mode configuration
 * @param props.initialCharacters - Initial list of characters
 */

"use client";

import {
  AnimatedTabs,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@elizaos/cloud-ui";
import Image from "@elizaos/cloud-ui/runtime/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";

async function createCharacter(elizaCharacter: ElizaCharacter): Promise<ElizaCharacter> {
  const res = await fetch("/api/my-agents/characters", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(elizaCharacter),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to create character (${res.status})`);
  }
  return (await res.json()) as ElizaCharacter;
}

async function updateCharacter(
  characterId: string,
  elizaCharacter: ElizaCharacter,
): Promise<ElizaCharacter> {
  const res = await fetch(`/api/my-agents/characters/${encodeURIComponent(characterId)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(elizaCharacter),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to update character (${res.status})`);
  }
  return (await res.json()) as ElizaCharacter;
}

async function getCharacter(characterId: string): Promise<ElizaCharacter> {
  const res = await fetch(`/api/my-agents/characters/${encodeURIComponent(characterId)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to fetch character (${res.status})`);
  }
  const data = (await res.json()) as { success: boolean; data: { character: ElizaCharacter } };
  return data.data.character;
}

import { useChatStore } from "@/lib/stores/chat-store";
import type { ElizaCharacter } from "@/lib/types";
import type { PreUploadedFile } from "@/lib/types/knowledge";
import { createDefaultCharacter } from "@/lib/utils/character-names";
import { BuildModeAssistant } from "./build-mode-assistant";
import { CharacterEditor } from "./character-editor";

interface CharacterBuildModeProps {
  initialCharacters: ElizaCharacter[];
  initialCharacterId?: string;
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export function CharacterBuildMode({
  initialCharacters,
  initialCharacterId,
  onUnsavedChanges,
}: CharacterBuildModeProps) {
  const { setRoomId, setSelectedCharacterId } = useChatStore();

  // Parent uses key={initialCharacterId} to force remount on character change
  const effectiveCharacterId = initialCharacterId || null;
  const { user } = useSessionAuth();
  const userId = user?.id || "";
  const navigate = useNavigate();

  // Ref to get the builder room ID from BuildModeAssistant
  const builderRoomIdRef = useRef<string | null>(null);

  // Track pending navigation after character creation to avoid race conditions
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);

  // Mobile view state: 'assistant' or 'editor'
  // Default to 'editor' when editing existing character, 'assistant' when creating new
  const [mobileView, setMobileView] = useState<"assistant" | "editor">(
    initialCharacterId ? "editor" : "assistant",
  );

  // Store the default character in a ref to prevent it from changing between renders
  // This prevents pre-uploaded files from being cleared unexpectedly in creator mode
  const defaultCharacterRef = useRef<ElizaCharacter | null>(null);

  // Clear default character ref when switching to an existing character
  // This is done in a separate effect to avoid side effects in useMemo
  useEffect(() => {
    if (effectiveCharacterId) {
      defaultCharacterRef.current = null;
    }
  }, [effectiveCharacterId]);

  // Derive character from effectiveCharacterId - avoid setState in effect
  // Use effectiveCharacterId to get correct character on first render
  const initialCharacter = useMemo(() => {
    if (effectiveCharacterId) {
      const found = initialCharacters.find((c) => c.id === effectiveCharacterId);
      if (found) return found;
    }
    // In creator mode, use a stable reference for the default character
    if (!defaultCharacterRef.current) {
      defaultCharacterRef.current = createDefaultCharacter();
    }
    return defaultCharacterRef.current;
  }, [effectiveCharacterId, initialCharacters]);

  // Creator mode: no selected character from database (creating new)
  // Build mode: editing an existing character from database
  // Use effectiveCharacterId to avoid flash on first render when store has stale value
  const isCreatorMode = !effectiveCharacterId;

  const [character, setCharacter] = useState<ElizaCharacter>(initialCharacter);
  const [preUploadedFiles, setPreUploadedFiles] = useState<PreUploadedFile[]>([]);

  // Track the character ID to detect actual character switches vs reference changes
  const previousCharacterIdRef = useRef<string | undefined>(initialCharacter.id);

  // Use functional updates to avoid stale closure issues with concurrent operations
  const handlePreUploadedFilesAdd = useCallback((newFiles: PreUploadedFile[]) => {
    setPreUploadedFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const handlePreUploadedFileRemove = useCallback((fileId: string) => {
    setPreUploadedFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  // Track unsaved changes (memoized to avoid JSON.stringify on every render)
  const hasUnsavedChanges = useMemo(() => {
    const hasCharacterChanges = JSON.stringify(character) !== JSON.stringify(initialCharacter);
    const hasFileChanges = preUploadedFiles.length > 0;
    return hasCharacterChanges || hasFileChanges;
  }, [character, initialCharacter, preUploadedFiles]);

  // Notify parent of unsaved changes state
  useEffect(() => {
    onUnsavedChanges?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onUnsavedChanges]);

  // Update local state only when switching to a DIFFERENT character (by ID)
  // This prevents data loss when parent re-renders with new array reference but same content
  useEffect(() => {
    const characterIdChanged = initialCharacter.id !== previousCharacterIdRef.current;
    if (characterIdChanged) {
      setCharacter(initialCharacter);
      setPreUploadedFiles([]);
      previousCharacterIdRef.current = initialCharacter.id;
    }
  }, [initialCharacter]);

  // Handle navigation after state updates have been committed
  // This avoids race conditions where navigate happens before state is applied
  useEffect(() => {
    if (pendingNavigation) {
      navigate(`/dashboard/chat?characterId=${pendingNavigation}`);
      setPendingNavigation(null);
    }
  }, [pendingNavigation, navigate]);

  const handleCharacterUpdate = useCallback((updates: Partial<ElizaCharacter>) => {
    setCharacter((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleExit = useCallback(() => {
    if (character.id) {
      navigate(`/dashboard/chat?characterId=${character.id}`);
    } else {
      navigate("/dashboard");
    }
  }, [character.id, navigate]);

  const handleSave = useCallback(async () => {
    if (!character.name) {
      toast.error("Character name is required");
      return;
    }

    if (!character.username) {
      toast.error("Username is required");
      return;
    }

    if (!character.bio) {
      toast.error("Character bio is required");
      return;
    }

    try {
      // Use character.id to detect if character exists (covers both database characters
      // and characters just created but not yet in initialCharacters)
      if (character.id) {
        // Update existing character
        await updateCharacter(character.id, character);

        // Process any pending pre-uploaded files
        if (preUploadedFiles.length > 0) {
          const filesToProcess = preUploadedFiles;
          const processedFileIds = new Set(filesToProcess.map((f) => f.id));

          const response = await fetch("/api/v1/knowledge/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              characterId: character.id,
              files: filesToProcess.map((f) => ({
                blobUrl: f.blobUrl,
                filename: f.filename,
                contentType: f.contentType,
                size: f.size,
              })),
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const failedCount = data.failedCount || 0;
            const successCount = data.successCount || 0;

            if (failedCount > 0 && data.results && Array.isArray(data.results)) {
              // Partial failure - store failed files in sessionStorage for retry
              const failedBlobUrls = new Set(
                data.results
                  .filter((r: { status: string }) => r.status === "error")
                  .map((r: { blobUrl: string }) => r.blobUrl),
              );
              const failedFiles = filesToProcess.filter((f) => failedBlobUrls.has(f.blobUrl));

              // Store failed files in sessionStorage for PendingKnowledgeProcessor to pick up
              let sessionStorageSucceeded = false;
              if (failedFiles.length > 0) {
                try {
                  sessionStorage.setItem(
                    `pendingKnowledge_${character.id}`,
                    JSON.stringify({
                      characterId: character.id,
                      characterName: character.name,
                      files: failedFiles.map((f) => ({
                        blobUrl: f.blobUrl,
                        filename: f.filename,
                        contentType: f.contentType,
                        size: f.size,
                      })),
                      createdAt: Date.now(),
                    }),
                  );
                  sessionStorageSucceeded = true;
                } catch {
                  // sessionStorage may fail in private browsing
                }
              }

              // Clear only the processed files from state, preserving any files added during the API call
              setPreUploadedFiles((prev) => prev.filter((f) => !processedFileIds.has(f.id)));
              if (sessionStorageSucceeded) {
                toast.warning("Character updated with partial file failures", {
                  description: `${successCount} file(s) processed, ${failedCount} failed. Failed files will be retried automatically.`,
                  duration: 6000,
                });
              } else {
                toast.warning("Character updated with partial file failures", {
                  description: `${successCount} file(s) processed, ${failedCount} failed. You can re-upload failed files from the Files tab.`,
                  duration: 6000,
                });
              }
            } else {
              // All files succeeded - clear all processed files
              setPreUploadedFiles((prev) => prev.filter((f) => !processedFileIds.has(f.id)));
              toast.success("Character updated! Redirecting to chat...", {
                description: `Processed ${successCount} file(s) for RAG knowledge base`,
                duration: 4000,
              });
            }
          } else {
            const errorData = await response.json().catch(() => ({}));

            // Store all files in sessionStorage for retry since API call failed
            let sessionStorageSucceeded = false;
            try {
              sessionStorage.setItem(
                `pendingKnowledge_${character.id}`,
                JSON.stringify({
                  characterId: character.id,
                  characterName: character.name,
                  files: filesToProcess.map((f) => ({
                    blobUrl: f.blobUrl,
                    filename: f.filename,
                    contentType: f.contentType,
                    size: f.size,
                  })),
                  createdAt: Date.now(),
                }),
              );
              sessionStorageSucceeded = true;
            } catch {
              // sessionStorage may fail in private browsing
            }

            // Clear only the processed files from state, preserving any files added during the API call
            setPreUploadedFiles((prev) => prev.filter((f) => !processedFileIds.has(f.id)));
            if (sessionStorageSucceeded) {
              toast.warning("Character updated, but file processing failed", {
                description: errorData.error || "Files will be retried automatically.",
                duration: 6000,
              });
            } else {
              toast.warning("Character updated, but file processing failed", {
                description: "File retry unavailable. You can re-upload files from the Files tab.",
                duration: 6000,
              });
            }
            onUnsavedChanges?.(false);
            // Still navigate to chat after update
            setPendingNavigation(character.id);
            return;
          }
        } else {
          toast.success("Character updated! Redirecting to chat...", {
            duration: 2000,
          });
        }

        onUnsavedChanges?.(false);

        // Navigate to chat mode after successful update
        setPendingNavigation(character.id);
      } else {
        // Create new character (creator mode)
        const saved = await createCharacter(character);

        if (saved.id) {
          // Capture files to process
          const filesToProcess = preUploadedFiles;

          // If we have files, store them in sessionStorage for the chat page to process
          // This allows us to redirect immediately and process files in the background
          if (filesToProcess.length > 0) {
            const pendingKnowledge = {
              characterId: saved.id,
              characterName: saved.name,
              files: filesToProcess.map((f) => ({
                blobUrl: f.blobUrl,
                filename: f.filename,
                contentType: f.contentType,
                size: f.size,
              })),
              createdAt: Date.now(),
            };
            let sessionStorageSucceeded = false;
            try {
              sessionStorage.setItem(
                `pendingKnowledge_${saved.id}`,
                JSON.stringify(pendingKnowledge),
              );
              sessionStorageSucceeded = true;
            } catch {
              // sessionStorage may fail in private browsing - files won't auto-process
              // but character creation still succeeded
            }

            if (sessionStorageSucceeded) {
              toast.success("Character created!", {
                description: `${filesToProcess.length} file(s) will be processed in the background`,
                duration: 4000,
              });
            } else {
              toast.success("Character created!", {
                description: `File processing unavailable. You can upload files from the Files tab.`,
                duration: 5000,
              });
            }
          } else {
            toast.success("Character created! Redirecting to chat...", {
              duration: 2000,
            });
          }

          // Clear pre-uploaded files state
          setPreUploadedFiles([]);

          // Lock the builder room if we have one (fire and forget)
          const roomId = builderRoomIdRef.current;
          if (roomId) {
            fetch(`/api/eliza/rooms/${roomId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                metadata: {
                  locked: true,
                  createdCharacterId: saved.id,
                  createdCharacterName: saved.name,
                  lockedAt: Date.now(),
                },
              }),
            }).catch(() => {});
          }

          // Mark changes as saved after successful creation
          onUnsavedChanges?.(false);

          // Clear room before navigating - chat page starts fresh with no stale room data
          setRoomId(null);

          // Use pendingNavigation pattern to defer navigation until state is committed
          setPendingNavigation(saved.id);
        } else {
          throw new Error("Character creation failed: no ID returned");
        }
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save character. Please try again.",
      );
    }
  }, [character, onUnsavedChanges, setRoomId, preUploadedFiles]);

  const handleCharacterRefresh = useCallback(async () => {
    if (!character.id) return;

    const refreshedCharacter = await getCharacter(character.id);

    // Update local state with fresh data from database
    setCharacter(refreshedCharacter);
  }, [character.id]);

  // Callback to receive the builder room ID from BuildModeAssistant
  const handleRoomIdChange = useCallback((roomId: string) => {
    builderRoomIdRef.current = roomId;
  }, []);

  // Callback when character is created via AI assistant (CREATE_CHARACTER action)
  const handleCharacterCreated = useCallback(
    (characterId: string, _characterName: string) => {
      // Clear unsaved changes since character was saved by the agent
      onUnsavedChanges?.(false);

      // Update store state first
      setRoomId(null);
      setSelectedCharacterId(characterId);

      // Trigger navigation via useEffect to ensure state updates are committed first
      // This avoids race conditions where the next page renders with stale state
      setPendingNavigation(characterId);
    },
    [onUnsavedChanges, setRoomId, setSelectedCharacterId],
  );

  return (
    <div className="flex h-full w-full min-h-0 overflow-hidden flex-col">
      <Image
        className="z-20 pointer-events-none absolute top-0 right-0 left-0"
        fill
        sizes="100vw"
        src="/elipse.svg"
        alt="background-elipse-builder-mode"
      />

      {/* Mobile Toggle Bar */}
      <div className="lg:hidden py-3 px-3 sm:px-6 bg-black shrink-0">
        <AnimatedTabs
          tabs={[
            { value: "assistant", label: "AI Assistant" },
            { value: "editor", label: "Editor" },
          ]}
          value={mobileView}
          onValueChange={(value) => setMobileView(value as "assistant" | "editor")}
          variant="orange"
          fullWidth
        />
      </div>

      {/* Mobile Single Panel View */}
      <div className="lg:hidden flex-1 overflow-hidden">
        {mobileView === "assistant" ? (
          <div className="flex h-full flex-col overflow-hidden">
            <BuildModeAssistant
              key={effectiveCharacterId || "creator"}
              character={character}
              onCharacterUpdate={handleCharacterUpdate}
              onCharacterRefresh={handleCharacterRefresh}
              onRoomIdChange={handleRoomIdChange}
              onCharacterCreated={handleCharacterCreated}
              userId={userId}
              isCreatorMode={isCreatorMode}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col overflow-hidden">
            <CharacterEditor
              character={character}
              onChange={setCharacter}
              onSave={handleSave}
              onExit={handleExit}
              hasUnsavedChanges={hasUnsavedChanges}
              preUploadedFiles={preUploadedFiles}
              onPreUploadedFilesAdd={handlePreUploadedFilesAdd}
              onPreUploadedFileRemove={handlePreUploadedFileRemove}
            />
          </div>
        )}
      </div>

      {/* Desktop Resizable Split Pane Layout */}
      <div className="z-0 hidden lg:flex h-full w-full min-h-0 overflow-hidden flex-1">
        <ResizablePanelGroup direction="horizontal" className="flex-1">
          {/* Left Panel - AI Assistant Chat */}
          <ResizablePanel defaultSize={50} minSize={40} maxSize={60}>
            <div
              className="flex h-full flex-col overflow-hidden pl-3 pb-3 pt-3 pr-1.5 bg-black"
              data-onboarding="build-assistant"
            >
              <BuildModeAssistant
                key={effectiveCharacterId || "creator"}
                character={character}
                onCharacterUpdate={handleCharacterUpdate}
                onCharacterRefresh={handleCharacterRefresh}
                onRoomIdChange={handleRoomIdChange}
                onCharacterCreated={handleCharacterCreated}
                userId={userId}
                isCreatorMode={isCreatorMode}
              />
            </div>
          </ResizablePanel>

          {/* Resizable Handle */}
          <ResizableHandle withHandle />

          {/* Right Panel - Character Editor */}
          <ResizablePanel defaultSize={50} minSize={40} maxSize={60}>
            <div
              className="flex h-full flex-col overflow-hidden pr-3 pb-3 pt-3 pl-1.5 bg-black"
              data-onboarding="build-editor"
            >
              <CharacterEditor
                character={character}
                onChange={setCharacter}
                onSave={handleSave}
                onExit={handleExit}
                hasUnsavedChanges={hasUnsavedChanges}
                preUploadedFiles={preUploadedFiles}
                onPreUploadedFilesAdd={handlePreUploadedFilesAdd}
                onPreUploadedFileRemove={handlePreUploadedFileRemove}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
