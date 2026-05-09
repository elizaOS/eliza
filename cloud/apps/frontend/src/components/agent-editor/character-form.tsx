/**
 * Character form component for editing character properties.
 * Supports name, bio, personality, message examples, post examples, style, and avatar management.
 *
 * @param props - Character form configuration
 * @param props.character - Character data to edit
 * @param props.onChange - Callback when character data changes
 */

"use client";

import {
  BrandButton,
  Input,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@elizaos/cloud-ui";
import { Globe, Info, Link as LinkIcon, Lock, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ElizaCharacter } from "@/lib/types";
import { AvatarGenerator } from "./avatar-generator";

export type FormTab = "basics" | "personality" | "style" | "avatar";

interface CharacterFormProps {
  character: ElizaCharacter;
  onChange: (character: ElizaCharacter) => void;
  activeTab: FormTab;
}

type TagType = "postExamples" | "adjectives" | "topics";

interface MessageExample {
  name: string;
  content: { text: string };
}

export function CharacterForm({ character, onChange, activeTab }: CharacterFormProps) {
  const [newTag, setNewTag] = useState("");
  const [newUserMessage, setNewUserMessage] = useState("");
  const [newAgentMessage, setNewAgentMessage] = useState("");
  const [isPublic, setIsPublic] = useState(character.isPublic ?? false);
  const [isTogglingShare, setIsTogglingShare] = useState(false);

  // Draft states for comma-separated fields (only parse on blur)
  const [adjectivesDraft, setAdjectivesDraft] = useState(character.adjectives?.join(", ") || "");
  const [topicsDraft, setTopicsDraft] = useState(character.topics?.join(", ") || "");

  // Focus tracking to prevent overwrites while user is editing
  const [isAdjectivesEditing, setIsAdjectivesEditing] = useState(false);
  const [isTopicsEditing, setIsTopicsEditing] = useState(false);

  // Sync isPublic state when character data changes (e.g., loaded from API)
  // Skip sync if currently toggling to prevent race condition
  useEffect(() => {
    if (!isTogglingShare) {
      setIsPublic(character.isPublic ?? false);
    }
  }, [character.isPublic, isTogglingShare]);

  // Sync draft states when character data changes externally (skip if user is editing)
  useEffect(() => {
    if (!isAdjectivesEditing) {
      setAdjectivesDraft(character.adjectives?.join(", ") || "");
    }
  }, [character.adjectives, isAdjectivesEditing]);

  useEffect(() => {
    if (!isTopicsEditing) {
      setTopicsDraft(character.topics?.join(", ") || "");
    }
  }, [character.topics, isTopicsEditing]);

  const handleToggleShare = async () => {
    if (isTogglingShare) return; // Prevent double-clicking

    const newIsPublic = !isPublic;

    // If character is not saved yet, just update local state
    if (!character.id) {
      setIsPublic(newIsPublic);
      onChange({ ...character, isPublic: newIsPublic });
      return;
    }

    // Character is saved, update via API
    setIsTogglingShare(true);
    setIsPublic(newIsPublic);

    try {
      const response = await fetch(`/api/my-agents/characters/${character.id}/share`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: newIsPublic }),
      });

      if (response.ok) {
        toast.success(newIsPublic ? "Agent is now public" : "Agent is now private");
      } else {
        setIsPublic(!newIsPublic);
        toast.error("Failed to update visibility");
      }
    } catch {
      setIsPublic(!newIsPublic);
      toast.error("Failed to update visibility");
    } finally {
      setIsTogglingShare(false);
    }
  };

  const handleCopyShareLink = async () => {
    if (!character.id) return;
    // Use username if available, otherwise fall back to character ID
    const shareUrl = character.username
      ? `${window.location.origin}/chat/@${character.username}`
      : `${window.location.origin}/chat/${character.id}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied!");
    } catch {
      toast.error("Failed to copy link to clipboard");
    }
  };

  const updateField = (field: keyof ElizaCharacter, value: unknown) => {
    onChange({ ...character, [field]: value });
  };

  // Parse comma-separated text to array (used on blur)
  const parseCommaSeparated = (text: string): string[] => {
    return text
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const addTag = (type: TagType) => {
    if (!newTag.trim()) return;

    const currentValue = character[type];
    const currentArray: string[] = Array.isArray(currentValue)
      ? currentValue.filter((item): item is string => typeof item === "string")
      : [];
    updateField(type, [...currentArray, newTag.trim()]);
    setNewTag("");
  };

  const removeTag = (type: TagType, index: number) => {
    const currentValue = character[type];
    const currentArray: string[] = Array.isArray(currentValue)
      ? currentValue.filter((item): item is string => typeof item === "string")
      : [];
    updateField(
      type,
      currentArray.filter((_, i) => i !== index),
    );
  };

  const addMessageExample = () => {
    if (!newUserMessage.trim() || !newAgentMessage.trim()) return;

    const conversation: MessageExample[] = [
      { name: "user", content: { text: newUserMessage.trim() } },
      {
        name: character.name || "agent",
        content: { text: newAgentMessage.trim() },
      },
    ];

    const currentExamples = character.messageExamples || [];
    updateField("messageExamples", [...currentExamples, conversation]);
    setNewUserMessage("");
    setNewAgentMessage("");
  };

  const removeMessageExample = (index: number) => {
    const currentExamples = character.messageExamples || [];
    updateField(
      "messageExamples",
      currentExamples.filter((_, i) => i !== index),
    );
  };

  const bioText =
    typeof character.bio === "string" ? character.bio : character.bio?.join("\n\n") || "";

  return (
    <div className={`relative z-10 ${activeTab === "avatar" ? "h-full" : "space-y-4"}`}>
      {/* Basics Tab */}
      {activeTab === "basics" && (
        <div className="space-y-6 mt-0">
          <div className="grid grid-cols-2 gap-6">
            <div className="flex flex-col space-y-2">
              <label htmlFor="name" className="text-sm font-medium text-white/70">
                Name *
              </label>
              <Input
                id="name"
                value={character.name || ""}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="Agent name"
                autoCapitalize="words"
                className="rounded-full border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-2.5 selection:bg-[#FF5800]/30 selection:text-white"
              />
            </div>

            <div className="flex flex-col space-y-2">
              <label htmlFor="username" className="text-sm font-medium text-white/70">
                Username *
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 select-none pointer-events-none">
                  @
                </span>
                <Input
                  id="username"
                  value={character.username || ""}
                  onChange={(e) => {
                    // Sanitize: remove @ prefix and allow only alphanumeric and hyphen (no underscores - server rejects them)
                    const sanitized = e.target.value
                      .replace(/^@/, "")
                      .replace(/[^a-zA-Z0-9-]/g, "");
                    updateField("username", sanitized);
                  }}
                  placeholder="eliza"
                  className="rounded-full border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] pl-8 pr-4 py-2.5 selection:bg-[#FF5800]/30 selection:text-white"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col space-y-2">
            <label htmlFor="bio" className="text-sm font-medium text-white/70">
              Bio *
            </label>
            <Textarea
              id="bio"
              value={bioText}
              onChange={(e) => updateField("bio", e.target.value)}
              placeholder="Describe the agent's background and purpose..."
              className="min-h-24 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-3"
            />
          </div>

          <div className="flex flex-col space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="system" className="text-sm font-medium text-white/70">
                System Prompt
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1.5">Core identity &amp; behavioral directives</p>
                  <p className="text-white/60">
                    The foundational prompt that defines who your agent is and how they should
                    behave.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Textarea
              id="system"
              value={character.system || ""}
              onChange={(e) => updateField("system", e.target.value)}
              placeholder="You are a helpful AI assistant focused on providing accurate information. Always fact-check before responding and cite sources when possible..."
              className="min-h-24 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-3"
            />
          </div>

          {/* Visibility Settings */}
          <div className="flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <label className="text-sm font-medium text-white/70">Visibility</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1.5">Public or Private</p>
                  <p className="text-white/60">
                    Public agents can be discovered and chatted with by anyone.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <div
              className={`flex items-center justify-between p-4 border border-white/10 bg-white/5 duration-200 ${isPublic ? "rounded-t-xl rounded-b" : "rounded-xl"}`}
            >
              <div className="flex items-center gap-3">
                {isPublic ? (
                  <Globe className="h-5 w-5 text-green-500" />
                ) : (
                  <Lock className="h-5 w-5 text-white/60" />
                )}
                <div>
                  <p className="text-sm font-medium text-white">
                    {isPublic ? "Public" : "Private"}
                  </p>
                  <p className="text-xs text-white/50">
                    {isPublic
                      ? "Anyone can chat with this agent"
                      : "Only you can access this agent"}
                  </p>
                </div>
              </div>
              {/* Custom Switch */}
              <button
                type="button"
                role="switch"
                aria-checked={isPublic}
                aria-label={isPublic ? "Make agent private" : "Make agent public"}
                onClick={handleToggleShare}
                disabled={isTogglingShare}
                className={`relative w-[62px] rounded-full p-1 transition-colors duration-300 border ${
                  !isTogglingShare ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                } ${
                  isPublic ? "bg-green-500/10 border-green-500/50" : "bg-white/5 border-white/10"
                }`}
              >
                <div
                  className={`h-7 w-7 rounded-full transition-all duration-300 ${
                    isPublic ? "translate-x-6 bg-green-600" : "translate-x-0 bg-white/20"
                  }`}
                />
              </button>
            </div>
            {isPublic && character.id && (
              <button
                type="button"
                onClick={handleCopyShareLink}
                className="flex items-center gap-3 mt-1 px-4 py-3 rounded-b-xl rounded-t border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-sm text-white/70 hover:text-white"
              >
                <LinkIcon className="h-5 w-5" />
                Copy Share Link
              </button>
            )}
          </div>
        </div>
      )}

      {/* Avatar Tab */}
      {activeTab === "avatar" && (
        <div className="h-full">
          {/* Avatar Generator - Quick styles and AI generation */}
          <AvatarGenerator
            characterName={character.name || "Character"}
            characterDescription={
              typeof character.bio === "string" ? character.bio : character.bio?.join(" ") || ""
            }
            currentAvatarUrl={character.avatarUrl}
            onAvatarChange={(url) => updateField("avatarUrl", url)}
          />
        </div>
      )}

      {/* Personality Tab */}
      {activeTab === "personality" && (
        <div className="space-y-6 mt-0">
          {/* Adjectives */}
          <div className="flex flex-col space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="adjectives" className="text-sm font-medium text-white/70">
                Personality Traits
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1">Adjectives that describe your agent</p>
                  <p className="text-white/70">
                    A random trait is selected for each response to add variety and personality.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Textarea
              id="adjectives"
              value={adjectivesDraft}
              onChange={(e) => setAdjectivesDraft(e.target.value)}
              onFocus={() => setIsAdjectivesEditing(true)}
              onBlur={() => {
                setIsAdjectivesEditing(false);
                updateField("adjectives", parseCommaSeparated(adjectivesDraft));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const parsed = parseCommaSeparated(adjectivesDraft);
                  updateField("adjectives", parsed);
                  setAdjectivesDraft(parsed.join(", "));
                }
              }}
              placeholder="witty, sarcastic, caring, thoughtful..."
              className="min-h-16 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-3"
            />
          </div>

          {/* Topics */}
          <div className="flex flex-col space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="topics" className="text-sm font-medium text-white/70">
                Topics of Interest
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1">What your agent loves talking about</p>
                  <p className="text-white/70">
                    Topics add contextual relevance to conversations. A current interest is
                    highlighted per response.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Textarea
              id="topics"
              value={topicsDraft}
              onChange={(e) => setTopicsDraft(e.target.value)}
              onFocus={() => setIsTopicsEditing(true)}
              onBlur={() => {
                setIsTopicsEditing(false);
                updateField("topics", parseCommaSeparated(topicsDraft));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const parsed = parseCommaSeparated(topicsDraft);
                  updateField("topics", parsed);
                  setTopicsDraft(parsed.join(", "));
                }
              }}
              placeholder="DeFi protocols, AI research, meme culture..."
              className="min-h-16 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-3"
            />
          </div>

          {/* Message Examples */}
          <div className="flex flex-col space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-white/70">Conversation Examples</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1">Teach your agent&apos;s conversation style</p>
                  <p className="text-white/70">
                    Add realistic user-agent exchanges that demonstrate tone, vocabulary, and
                    response patterns.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Add new conversation example */}
            <div className="flex flex-col space-y-1.5">
              <label className="text-xs text-white/50">User says:</label>
              <div className="flex gap-2">
                <Input
                  value={newUserMessage}
                  onChange={(e) => setNewUserMessage(e.target.value)}
                  placeholder="What's the best way to start learning about crypto?"
                  className="flex-1 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-2.5 selection:bg-[#FF5800]/30 selection:text-white"
                />
                <div className="hidden sm:block shrink-0 size-10" />
              </div>
            </div>
            <div className="flex flex-col space-y-1.5">
              <label className="text-xs text-white/50">Agent responds:</label>
              <div className="flex gap-2 items-end">
                <Textarea
                  value={newAgentMessage}
                  onChange={(e) => setNewAgentMessage(e.target.value)}
                  placeholder="Great question! I'd recommend starting with Bitcoin and Ethereum basics..."
                  className="flex-1 h-20 resize-none rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-3 selection:bg-[#FF5800]/30 selection:text-white"
                />
                <BrandButton
                  type="button"
                  variant="icon-primary"
                  size="icon"
                  disabled={!newUserMessage.trim() || !newAgentMessage.trim()}
                  onClick={addMessageExample}
                  className="hidden sm:flex"
                >
                  <Plus
                    className="h-4 w-4"
                    style={{
                      color:
                        !newUserMessage.trim() || !newAgentMessage.trim()
                          ? "rgba(255,255,255,0.4)"
                          : "#FF5800",
                    }}
                  />
                </BrandButton>
              </div>
            </div>
            {/* Mobile add button */}
            <button
              type="button"
              onClick={addMessageExample}
              disabled={!newUserMessage.trim() || !newAgentMessage.trim()}
              className={`sm:hidden flex items-center justify-center gap-2 w-full rounded-xl px-4 py-2.5 transition-colors ${
                !newUserMessage.trim() || !newAgentMessage.trim()
                  ? "border border-white/10 bg-white/5 text-white/40 cursor-not-allowed"
                  : "border border-[#FF5800]/50 bg-[#FF5800]/40 text-white hover:bg-[#FF5800]/55 hover:border-[#FF5800]/90"
              }`}
            >
              <Plus className="h-4 w-4" />
              Add Example
            </button>

            {/* Existing conversation examples */}
            {character.messageExamples && character.messageExamples.length > 0 && (
              <div className="space-y-2 pt-2">
                {character.messageExamples.map((conversation, index) => (
                  <div
                    key={index}
                    className="relative rounded-l-sm rounded-r-xl bg-white/5 border border-white/10 p-3 pr-10 border-l-2 border-l-[#FF5800]"
                  >
                    <button
                      onClick={() => removeMessageExample(index)}
                      className="absolute top-2 right-2 p-1 rounded-md hover:bg-red-500/20 transition-all"
                    >
                      <X className="h-3.5 w-3.5 text-white/50 hover:text-red-400" />
                    </button>
                    <div className="space-y-1">
                      {conversation.map((message, msgIndex) => (
                        <div key={msgIndex} className="flex gap-2 text-sm">
                          <span className="text-[#FF5800] font-semibold shrink-0">
                            {message.name === "user" || message.name === "{{user1}}" ? "U:" : "A:"}
                          </span>
                          <span className="text-white/80">{message.content.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Post Examples */}
          <div className="flex flex-col space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-white/70">Post Examples</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1">Sample social media posts</p>
                  <p className="text-white/70">
                    Add examples of posts your agent might create on social platforms like
                    Twitter/X.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex gap-2">
              <Input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="Just discovered an amazing DeFi protocol! 🚀 Thread below..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag("postExamples");
                  }
                }}
                className="rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-2.5 selection:bg-[#FF5800]/30 selection:text-white"
              />
              <BrandButton
                type="button"
                variant="icon-primary"
                size="icon"
                disabled={!newTag.trim()}
                onClick={() => addTag("postExamples")}
              >
                <Plus
                  className="h-4 w-4"
                  style={{
                    color: !newTag.trim() ? "rgba(255,255,255,0.4)" : "#FF5800",
                  }}
                />
              </BrandButton>
            </div>
            <div className="space-y-2">
              {character.postExamples?.map((post, index) => (
                <div
                  key={index}
                  className="flex items-start gap-2 rounded-xl bg-white/5 border border-white/10 p-3"
                >
                  <p className="flex-1 text-sm text-white">{post}</p>
                  <button
                    onClick={() => removeTag("postExamples", index)}
                    className="p-1 rounded-md hover:bg-red-500/20 transition-colors"
                  >
                    <X className="h-3.5 w-3.5 text-white/50 hover:text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Style Tab */}
      {activeTab === "style" && (
        <div className="space-y-6 mt-0">
          <div className="flex flex-col space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="style-all" className="text-sm font-medium text-white/70">
                General Style Guidelines
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1">Universal style rules for all contexts</p>
                  <p className="text-white/70">
                    Define overarching style rules that apply everywhere (chats AND posts).
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Textarea
              id="style-all"
              value={
                Array.isArray(character.style?.all)
                  ? character.style.all.join("\n")
                  : typeof character.style?.all === "string"
                    ? character.style.all
                    : ""
              }
              onChange={(e) =>
                updateField("style", {
                  ...character.style,
                  all: e.target.value.split("\n").filter((s) => s.trim()),
                })
              }
              placeholder={"Be friendly and approachable\nUse clear, simple language"}
              className="min-h-20 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-3 selection:bg-[#FF5800]/30 selection:text-white"
            />
          </div>

          <div className="flex flex-col space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="style-chat" className="text-sm font-medium text-white/70">
                Chat Style Guidelines
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1">Style rules for conversations</p>
                  <p className="text-white/70">
                    Define how your agent behaves in one-on-one conversations and direct messages.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Textarea
              id="style-chat"
              value={
                Array.isArray(character.style?.chat)
                  ? character.style.chat.join("\n")
                  : typeof character.style?.chat === "string"
                    ? character.style.chat
                    : ""
              }
              onChange={(e) =>
                updateField("style", {
                  ...character.style,
                  chat: e.target.value.split("\n").filter((s) => s.trim()),
                })
              }
              placeholder={
                "Keep responses concise and focused\nAsk follow-up questions to understand better"
              }
              className="min-h-20 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-3 selection:bg-[#FF5800]/30 selection:text-white"
            />
          </div>

          <div className="flex flex-col space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="style-post" className="text-sm font-medium text-white/70">
                Post Style Guidelines
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-white/40 hover:text-white/70 transition-colors" />
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-xs bg-white/5 backdrop-blur-md border border-white/10 text-white"
                >
                  <p className="font-medium mb-1">Style rules for social media posts</p>
                  <p className="text-white/70">
                    Define how your agent creates public posts on platforms like Twitter/X.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Textarea
              id="style-post"
              value={
                Array.isArray(character.style?.post)
                  ? character.style.post.join("\n")
                  : typeof character.style?.post === "string"
                    ? character.style.post
                    : ""
              }
              onChange={(e) =>
                updateField("style", {
                  ...character.style,
                  post: e.target.value.split("\n").filter((s) => s.trim()),
                })
              }
              placeholder={"Start with an engaging hook\nEnd with a call-to-action or question"}
              className="min-h-20 rounded-xl border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] px-4 py-3 selection:bg-[#FF5800]/30 selection:text-white"
            />
          </div>
        </div>
      )}
    </div>
  );
}
