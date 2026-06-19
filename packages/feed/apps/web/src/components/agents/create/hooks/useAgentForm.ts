import type { AgentTemplate } from "@feed/agents/client";
import {
  getAgentDefaultProfileImageUrl,
  logger,
  randomAgentDefaultProfileIndex,
} from "@feed/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { createNameMatchRegex, generateAgentName } from "@/utils/nameGenerator";

const TOTAL_BANNERS = 100;
const STORAGE_KEY = "feed_agent_draft";
/** Stable idempotency key for one fal avatar per agent-create session (server dedupes). */
const AGENT_AVATAR_IDEM_SESSION_KEY = "feed_agent_avatar_idem";

function getOrCreateAgentAvatarIdempotencyKey(): string {
  try {
    let k = sessionStorage.getItem(AGENT_AVATAR_IDEM_SESSION_KEY);
    if (!k) {
      k = crypto.randomUUID();
      sessionStorage.setItem(AGENT_AVATAR_IDEM_SESSION_KEY, k);
    }
    return k;
  } catch {
    return crypto.randomUUID();
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

// Debounce delay for name replacement in prompts (ms)
const NAME_REPLACEMENT_DEBOUNCE_MS = 300;

export interface ProfileFormData {
  username: string;
  displayName: string;
  bio: string;
  profileImageUrl: string;
  coverImageUrl: string;
}

export interface AgentFormData {
  system: string;
  personality: string;
  tradingStrategy: string;
  initialDeposit: number;
}

interface UseAgentFormResult {
  profileData: ProfileFormData;
  agentData: AgentFormData;
  isInitialized: boolean;
  generatingField: string | null;
  updateProfileField: (field: keyof ProfileFormData, value: string) => void;
  updateAgentField: (
    field: keyof AgentFormData,
    value: string | number,
  ) => void;
  regenerateField: (field: string) => Promise<void>;
  clearDraft: () => void;
}

/**
 * Hook for managing agent creation form state
 *
 * Features:
 * - Auto-loads random template on init
 * - Persists draft to localStorage
 * - AI-powered field regeneration
 * - Profile and agent config state management
 */
export function useAgentForm(): UseAgentFormResult {
  const { getAccessToken } = useAuth();

  // Generate default agent name on mount
  const [initialName] = useState(() => generateAgentName());

  const [profileData, setProfileData] = useState<ProfileFormData>({
    username: initialName.username,
    displayName: initialName.displayName,
    bio: "",
    profileImageUrl: "",
    coverImageUrl: "",
  });

  const [agentData, setAgentData] = useState<AgentFormData>({
    system: "",
    personality: "",
    tradingStrategy: "",
    initialDeposit: 100,
  });

  const [isInitialized, setIsInitialized] = useState(false);
  const [generatingField, setGeneratingField] = useState<string | null>(null);

  // Track the name currently used in prompts (for replacement when user changes it)
  const nameInPromptsRef = useRef<string>(initialName.displayName);
  // Debounce timer for name replacement to handle rapid typing
  const nameReplacementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  /** Bumped each effect run so stale async work (e.g. React Strict Mode) does not apply template state. */
  const templateLoadGenerationRef = useRef(0);

  // Load template on mount
  useEffect(() => {
    const generation = ++templateLoadGenerationRef.current;
    const avatarAbort = new AbortController();

    const loadTemplate = async () => {
      // Clear any old draft - we want fresh template with name modal
      localStorage.removeItem(STORAGE_KEY);

      const idempotencyKey = getOrCreateAgentAvatarIdempotencyKey();

      try {
        const indexResponse = await fetch("/api/agent-templates");
        if (!indexResponse.ok) {
          logger.error(
            "Failed to load template index",
            undefined,
            "useAgentForm",
          );
          if (generation === templateLoadGenerationRef.current) {
            setIsInitialized(true);
          }
          return;
        }

        const index = (await indexResponse.json()) as { templates: string[] };
        if (!index.templates || index.templates.length === 0) {
          if (generation === templateLoadGenerationRef.current) {
            setIsInitialized(true);
          }
          return;
        }

        const randomTemplate =
          index.templates[Math.floor(Math.random() * index.templates.length)];
        if (!randomTemplate) {
          return;
        }
        const templateResponse = await fetch(
          `/api/agent-templates/${randomTemplate}`,
        );

        if (!templateResponse.ok) {
          if (generation === templateLoadGenerationRef.current) {
            setIsInitialized(true);
          }
          return;
        }

        const template = (await templateResponse.json()) as AgentTemplate;

        if (generation !== templateLoadGenerationRef.current) {
          return;
        }

        // Random images
        const randomPfp = randomAgentDefaultProfileIndex();
        const randomBanner = Math.floor(Math.random() * TOTAL_BANNERS) + 1;

        // Update profile data (preserve generated name)
        setProfileData((prev) => ({
          username: prev.username,
          displayName: prev.displayName,
          bio: template.description,
          profileImageUrl:
            prev.profileImageUrl || getAgentDefaultProfileImageUrl(randomPfp),
          coverImageUrl:
            prev.coverImageUrl ||
            `/assets/user-banners/banner-${randomBanner}.jpg`,
        }));

        // Replace {{agentName}} placeholder with generated display name
        const displayName = initialName.displayName;
        setAgentData((prev) => ({
          system: template.system.replace(/\{\{agentName\}\}/g, displayName),
          personality: template.personality.replace(
            /\{\{agentName\}\}/g,
            displayName,
          ),
          tradingStrategy: template.tradingStrategy.replace(
            /\{\{agentName\}\}/g,
            displayName,
          ),
          initialDeposit: prev.initialDeposit,
        }));

        setIsInitialized(true);

        const token = await getAccessToken();
        if (!token || generation !== templateLoadGenerationRef.current) {
          return;
        }

        const avatarRes = await fetch("/api/agents/generate-avatar", {
          method: "POST",
          signal: avatarAbort.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ displayName, idempotencyKey }),
        });
        if (generation !== templateLoadGenerationRef.current) {
          return;
        }
        if (avatarRes.ok) {
          const payload = (await avatarRes.json()) as { url?: string };
          if (payload.url?.trim()) {
            const profileImageUrl = payload.url.trim();
            setProfileData((prev) => ({
              ...prev,
              profileImageUrl,
            }));
          }
        }
      } catch (e) {
        if (isAbortError(e)) {
          return;
        }
        throw e;
      }
    };

    loadTemplate();
    return () => avatarAbort.abort();
    // initialName.displayName is stable (from useState initializer), so this effectively runs once on mount
  }, [getAccessToken, initialName.displayName]);

  // Note: When displayName changes, we find and replace the old name with the new name
  // in the system prompt, personality, and trading strategy fields.

  // Auto-save to localStorage
  useEffect(() => {
    if (!isInitialized) return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ profileData, agentData }),
    );
  }, [profileData, agentData, isInitialized]);

  const updateProfileField = useCallback(
    (field: keyof ProfileFormData, value: string) => {
      setProfileData((prev) => ({ ...prev, [field]: value }));

      // When displayName changes, replace the old name with new name in prompts
      // Debounced to handle rapid typing and prevent race conditions
      if (field === "displayName" && value) {
        // Clear any pending replacement
        if (nameReplacementTimerRef.current) {
          clearTimeout(nameReplacementTimerRef.current);
        }

        nameReplacementTimerRef.current = setTimeout(() => {
          const oldName = nameInPromptsRef.current;

          // Only replace if there's a previous name and it's different
          if (oldName && oldName !== value) {
            // Use flexible boundaries that handle punctuation/unicode better than \b
            const oldNameRegex = createNameMatchRegex(oldName);

            setAgentData((prevAgent) => ({
              ...prevAgent,
              system: prevAgent.system.replace(oldNameRegex, value),
              personality: prevAgent.personality.replace(oldNameRegex, value),
              tradingStrategy: prevAgent.tradingStrategy.replace(
                oldNameRegex,
                value,
              ),
            }));
          }

          // Update the tracked name after replacement
          nameInPromptsRef.current = value;
        }, NAME_REPLACEMENT_DEBOUNCE_MS);
      }
    },
    [],
  );

  const updateAgentField = useCallback(
    (field: keyof AgentFormData, value: string | number) => {
      setAgentData((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const regenerateField = useCallback(
    async (field: string) => {
      setGeneratingField(field);

      const token = await getAccessToken();
      if (!token) {
        toast.error("Authentication required");
        setGeneratingField(null);
        return;
      }

      const response = await fetch("/api/agents/generate-field", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fieldName: field,
          currentValue: agentData[field as keyof AgentFormData],
          context: {
            name: profileData.displayName,
            description: profileData.bio,
            system: agentData.system,
            personality: agentData.personality,
            tradingStrategy: agentData.tradingStrategy,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        toast.error(errorData.error || "Failed to generate field");
        setGeneratingField(null);
        return;
      }

      const result = await response.json();
      const value = (result.value as string).trim();

      if (field === "personality") {
        const personalityLines = value
          .split("|")
          .map((s: string) => s.trim())
          .filter((s: string) => s);
        updateAgentField("personality", personalityLines.join("\n"));
      } else {
        updateAgentField(
          field as keyof AgentFormData,
          value.replace(/\n\n+/g, "\n"),
        );
      }

      setGeneratingField(null);
    },
    [agentData, profileData, getAccessToken, updateAgentField],
  );

  const clearDraft = useCallback(() => {
    try {
      sessionStorage.removeItem(AGENT_AVATAR_IDEM_SESSION_KEY);
    } catch {
      // ignore
    }
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return {
    profileData,
    agentData,
    isInitialized,
    generatingField,
    updateProfileField,
    updateAgentField,
    regenerateField,
    clearDraft,
  };
}
