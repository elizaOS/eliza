"use client";

import { Camera, Save, Trash2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import {
  type AgentConfigurationData,
  AgentConfigurationForm,
} from "./AgentConfigurationForm";

/**
 * Agent settings component for configuring agent properties.
 *
 * Provides a comprehensive form for editing agent settings including
 * name, description, profile image, system prompt, personality, trading
 * strategy, model tier, and autonomous capabilities. Includes save and
 * delete functionality.
 *
 * Features:
 * - Agent profile editing
 * - System prompt editing
 * - Personality/bio editing
 * - Trading strategy editing
 * - Model tier selection
 * - Autonomous capability toggles
 * - Save functionality
 * - Delete functionality
 * - Loading states
 * - Error handling
 *
 * @param props - AgentSettings component props
 * @returns Agent settings element
 *
 * @example
 * ```tsx
 * <AgentSettings
 *   agent={agentData}
 *   onUpdate={() => refreshAgent()}
 * />
 * ```
 */
interface AgentSettingsProps {
  agent: {
    id: string;
    name: string;
    description?: string;
    profileImageUrl?: string;
    system: string;
    bio?: string[];
    personality?: string;
    tradingStrategy?: string;
    modelTier: "free" | "pro";
    isActive: boolean;
    autonomousEnabled: boolean;
    autonomousPosting?: boolean;
    autonomousCommenting?: boolean;
    autonomousDMs?: boolean;
    autonomousGroupChats?: boolean;
    a2aEnabled?: boolean;
  };
  onUpdate: () => void;
}

export function AgentSettings({ agent, onUpdate }: AgentSettingsProps) {
  const router = useRouter();
  const { getAccessToken } = useAuth();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [profileImage, setProfileImage] = useState<{
    file: File | null;
    preview: string | null;
  }>({ file: null, preview: null });
  const profileImageInputRef = useRef<HTMLInputElement>(null);
  const [formData, setFormData] = useState({
    name: agent.name,
    description: agent.description || "",
    profileImageUrl: agent.profileImageUrl || "",
    system: agent.system,
    bio: Array.isArray(agent.bio) ? agent.bio.filter((b) => b).join("\n") : "",
    personality:
      agent.personality ||
      (Array.isArray(agent.bio) ? agent.bio.filter((b) => b).join("\n") : ""),
    tradingStrategy: agent.tradingStrategy || "",
    modelTier: agent.modelTier,
    isActive: agent.isActive,
    autonomousEnabled: agent.autonomousEnabled,
    autonomousPosting: agent.autonomousPosting || false,
    autonomousCommenting: agent.autonomousCommenting || false,
    autonomousDMs: agent.autonomousDMs || false,
    autonomousGroupChats: agent.autonomousGroupChats || false,
    a2aEnabled: agent.a2aEnabled || false,
  });

  // Extract configuration data for the shared component
  const configData: AgentConfigurationData = {
    modelTier: formData.modelTier,
    autonomousEnabled: formData.autonomousEnabled,
    autonomousPosting: formData.autonomousPosting,
    autonomousCommenting: formData.autonomousCommenting,
    autonomousDMs: formData.autonomousDMs,
    autonomousGroupChats: formData.autonomousGroupChats,
    a2aEnabled: formData.a2aEnabled,
  };

  const handleConfigChange = (newConfig: AgentConfigurationData) => {
    setFormData((prev) => ({ ...prev, ...newConfig }));
  };

  const handleProfileImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be less than 5MB");
      return;
    }

    // Create preview
    const reader = new FileReader();
    reader.onload = () => {
      setProfileImage({
        file,
        preview: reader.result as string,
      });
      // Clear URL input when file is selected for consistency
      setFormData((prev) => ({ ...prev, profileImageUrl: "" }));
    };
    reader.onerror = () => {
      toast.error("Failed to read image file");
      setProfileImage({ file: null, preview: null });
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    setSaving(true);
    const token = await getAccessToken();
    if (!token) {
      toast.error("Authentication required");
      setSaving(false);
      return;
    }

    try {
      const updatedData = { ...formData };

      // Upload profile image if changed
      if (profileImage.file) {
        const uploadFormData = new FormData();
        uploadFormData.append("file", profileImage.file);
        uploadFormData.append("type", "profile");

        const uploadResponse = await fetch("/api/upload/image", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: uploadFormData,
        });

        if (!uploadResponse.ok) {
          toast.error("Failed to upload profile image");
          setSaving(false);
          return;
        }

        const uploadData = await uploadResponse.json();
        if (
          !uploadData ||
          typeof uploadData.url !== "string" ||
          uploadData.url.trim() === ""
        ) {
          toast.error("Invalid upload response");
          setSaving(false);
          return;
        }
        updatedData.profileImageUrl = uploadData.url;
      }

      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...updatedData,
          bio: updatedData.personality.trim()
            ? [updatedData.personality.trim()]
            : [],
          system: updatedData.tradingStrategy.trim()
            ? `${updatedData.system}\n\nTrading Strategy: ${updatedData.tradingStrategy}`
            : updatedData.system,
        }),
      });

      if (!res.ok) {
        const error = (await res.json()) as { error?: string };
        toast.error(error.error || "Failed to update agent");
        setSaving(false);
        return;
      }

      toast.success("Agent updated successfully");
      setProfileImage({ file: null, preview: null }); // Reset image state
      onUpdate();
      setSaving(false);
    } catch (_error) {
      toast.error("An error occurred while saving");
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (
      !confirm(
        `Are you sure you want to delete ${agent.name}? This cannot be undone.`,
      )
    ) {
      return;
    }

    setDeleting(true);
    const token = await getAccessToken();

    if (!token) {
      toast.error("Authentication required");
      setDeleting(false);
      return;
    }

    const res = await fetch(`/api/agents/${agent.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }).catch(() => {
      toast.error("Failed to delete agent");
      setDeleting(false);
      throw new Error("Failed to delete agent");
    });

    if (res.ok) {
      toast.success("Agent deleted successfully");
      router.push("/agents");
    } else {
      const error = await res.json();
      toast.error(error.error || "Failed to delete agent");
    }

    setDeleting(false);
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="rounded-lg border border-border bg-card/50 p-4 backdrop-blur sm:p-6">
        <h3 className="mb-4 font-semibold text-base sm:text-lg">
          Basic Information
        </h3>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block font-medium text-sm">Name</label>
            <Input
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              placeholder="Agent name"
              className="w-full"
            />
          </div>

          <div>
            <label className="mb-2 block font-medium text-sm">
              Description
            </label>
            <Textarea
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              placeholder="Brief description..."
              rows={3}
              className="min-h-[80px] w-full resize-y"
            />
          </div>

          <div>
            <label className="mb-2 block font-medium text-sm">
              Profile Image
            </label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              {/* Image Preview */}
              <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                {profileImage.preview || formData.profileImageUrl ? (
                  <img
                    src={profileImage.preview || formData.profileImageUrl}
                    alt="Profile preview"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    <Camera className="h-8 w-8" />
                  </div>
                )}
              </div>

              {/* Upload Controls */}
              <div className="flex flex-1 flex-col gap-2">
                <input
                  ref={profileImageInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleProfileImageSelect}
                  className="hidden"
                  disabled={saving}
                />
                <button
                  type="button"
                  onClick={() => profileImageInputRef.current?.click()}
                  disabled={saving}
                  className="flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2 font-medium text-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
                >
                  <Upload className="h-4 w-4" />
                  {profileImage.preview || formData.profileImageUrl
                    ? "Change Image"
                    : "Upload Image"}
                </button>

                {/* URL Input as fallback */}
                <Input
                  value={formData.profileImageUrl}
                  onChange={(e) => {
                    setFormData({
                      ...formData,
                      profileImageUrl: e.target.value,
                    });
                    // Clear file upload when URL is entered for consistency
                    if (e.target.value.trim()) {
                      setProfileImage({ file: null, preview: null });
                    }
                  }}
                  placeholder="Or paste image URL..."
                  className="w-full text-sm"
                  disabled={saving}
                />
                <p className="text-muted-foreground text-xs">
                  Upload an image or provide a URL. Max 5MB.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card/50 p-4 backdrop-blur sm:p-6">
        <h3 className="mb-4 font-semibold text-base sm:text-lg">Personality</h3>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block font-medium text-sm">
              Important Directions
            </label>
            <Textarea
              value={formData.system}
              onChange={(e) =>
                setFormData({ ...formData, system: e.target.value })
              }
              placeholder="You are an AI agent who..."
              rows={4}
              className="min-h-[100px] w-full resize-y"
            />
          </div>

          <div>
            <label className="mb-2 block font-medium text-sm">
              Personality (maps to bio array)
            </label>
            <Textarea
              value={formData.personality}
              onChange={(e) =>
                setFormData({ ...formData, personality: e.target.value })
              }
              placeholder="One personality trait per line..."
              rows={4}
              className="min-h-[100px] w-full resize-y"
            />
          </div>

          <div>
            <label className="mb-2 block font-medium text-sm">
              Trading Strategy
            </label>
            <Textarea
              value={formData.tradingStrategy}
              onChange={(e) =>
                setFormData({ ...formData, tradingStrategy: e.target.value })
              }
              placeholder="Describe trading approach..."
              rows={4}
              className="min-h-[100px] w-full resize-y"
            />
            <p className="mt-1.5 text-muted-foreground text-xs">
              This will be appended to the system prompt.
            </p>
          </div>
        </div>
      </div>

      {/* Configuration - using shared component */}
      <AgentConfigurationForm
        data={configData}
        onChange={handleConfigChange}
        agentId={agent.id}
      />

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-[#0066FF] px-6 py-2 font-medium text-primary-foreground transition-all hover:bg-[#2952d9] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>

      {/* Danger Zone */}
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 backdrop-blur sm:p-6">
        <h3 className="mb-2 font-semibold text-base text-red-400 sm:text-lg">
          Danger Zone
        </h3>
        <p className="mb-4 text-muted-foreground text-xs sm:text-sm">
          Once you delete an agent, there is no going back. Please be certain.
        </p>

        <button
          onClick={handleDelete}
          disabled={deleting}
          className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 font-medium text-red-400 text-sm transition-all hover:border-red-500/30 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:px-6"
        >
          <Trash2 className="h-4 w-4" />
          {deleting ? "Deleting..." : "Delete Agent"}
        </button>
      </div>
    </div>
  );
}
