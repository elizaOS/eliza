"use client";

import { cn } from "@polyagent/shared";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Upload,
  X as XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import type { ProfileFormData } from "../hooks/useAgentForm";
import { useAgentUsernameCheck } from "../hooks/useAgentUsernameCheck";

const TOTAL_PROFILE_PICTURES = 100;
const TOTAL_BANNERS = 100;
const MAX_BIO_LENGTH = 160;

interface AgentSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  profileData: ProfileFormData;
  onSave: (data: ProfileFormData) => void;
}

export function AgentSetupModal({
  isOpen,
  onClose,
  profileData,
  onSave,
}: AgentSetupModalProps) {
  const { getAccessToken } = useAuth();
  const [localData, setLocalData] = useState<ProfileFormData>(profileData);
  const bioInitialized = useRef(false);

  // Reset bio initialization flag when modal closes so new data can sync on reopen
  useEffect(() => {
    if (!isOpen) {
      bioInitialized.current = false;
    }
  }, [isOpen]);

  // Sync bio from profileData when template loads (bio comes from template.description)
  // Truncate to MAX_BIO_LENGTH characters if needed
  // Uses ref to track initialization so user can clear bio without it being re-synced
  useEffect(() => {
    if (profileData.bio && !bioInitialized.current) {
      setLocalData((prev) => ({
        ...prev,
        bio: profileData.bio.slice(0, MAX_BIO_LENGTH),
      }));
      bioInitialized.current = true;
    }
  }, [profileData.bio]);

  // Username availability check
  const { usernameStatus, usernameSuggestion, isCheckingUsername, retryCheck } =
    useAgentUsernameCheck(localData.username);
  const [uploadingImage, setUploadingImage] = useState<
    "profile" | "cover" | null
  >(null);
  const [profilePictureIndex, setProfilePictureIndex] = useState(() => {
    // Extract index from URL if it's a local asset
    const match = profileData.profileImageUrl?.match(/profile-(\d+)\.jpg/);
    return match?.[1] ? parseInt(match[1], 10) : 1;
  });
  const [bannerIndex, setBannerIndex] = useState(() => {
    // Extract index from URL if it's a local asset
    const match = profileData.coverImageUrl?.match(/banner-(\d+)\.jpg/);
    return match?.[1] ? parseInt(match[1], 10) : 1;
  });
  const [uploadedProfileImage, setUploadedProfileImage] = useState<
    string | null
  >(
    profileData.profileImageUrl?.startsWith("/assets/")
      ? null
      : profileData.profileImageUrl || null,
  );
  const [uploadedBanner, setUploadedBanner] = useState<string | null>(
    profileData.coverImageUrl?.startsWith("/assets/")
      ? null
      : profileData.coverImageUrl || null,
  );

  const profileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Computed current images
  const currentProfileImage = useMemo(() => {
    return (
      uploadedProfileImage ||
      `/assets/user-profiles/profile-${profilePictureIndex}.jpg`
    );
  }, [uploadedProfileImage, profilePictureIndex]);

  const currentBanner = useMemo(() => {
    return uploadedBanner || `/assets/user-banners/banner-${bannerIndex}.jpg`;
  }, [uploadedBanner, bannerIndex]);

  // Cycle profile picture
  const cycleProfilePicture = useCallback((direction: "next" | "prev") => {
    setUploadedProfileImage(null);
    setProfilePictureIndex((prev) => {
      if (direction === "next") {
        return prev >= TOTAL_PROFILE_PICTURES ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_PROFILE_PICTURES : prev - 1;
    });
  }, []);

  // Cycle banner
  const cycleBanner = useCallback((direction: "next" | "prev") => {
    setUploadedBanner(null);
    setBannerIndex((prev) => {
      if (direction === "next") {
        return prev >= TOTAL_BANNERS ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_BANNERS : prev - 1;
    });
  }, []);

  const handleImageUpload = useCallback(
    async (type: "profile" | "cover", file: File) => {
      if (file.size > 5 * 1024 * 1024) {
        toast.error("Image must be smaller than 5MB");
        return;
      }

      if (
        !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          file.type,
        )
      ) {
        toast.error("Please upload a valid image file");
        return;
      }

      setUploadingImage(type);

      const token = await getAccessToken();
      if (!token) {
        toast.error("Authentication required");
        setUploadingImage(null);
        return;
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append(
        "type",
        type === "profile" ? "profileImage" : "coverImage",
      );

      const response = await fetch("/api/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        toast.error(errorData.error || "Upload failed");
        setUploadingImage(null);
        return;
      }

      const result = await response.json();
      if (type === "profile") {
        setUploadedProfileImage(result.url);
      } else {
        setUploadedBanner(result.url);
      }
      toast.success(
        `${type === "profile" ? "Profile" : "Cover"} image uploaded`,
      );
      setUploadingImage(null);
    },
    [getAccessToken],
  );

  const handleProfileImageUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      handleImageUpload("profile", file);
    },
    [handleImageUpload],
  );

  const handleBannerUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      handleImageUpload("cover", file);
    },
    [handleImageUpload],
  );

  const handleContinue = () => {
    if (!localData.username.trim()) {
      toast.error("Username is required");
      return;
    }
    if (localData.username.length < 3) {
      toast.error("Username must be at least 3 characters");
      return;
    }
    if (usernameStatus !== "available") {
      toast.error("Please choose an available username");
      return;
    }
    if (!localData.displayName.trim()) {
      toast.error("Display name is required");
      return;
    }
    onSave({
      ...localData,
      profileImageUrl: currentProfileImage,
      coverImageUrl: currentBanner,
    });
    // Note: onSave handler in page.tsx closes the modal via setShowProfileModal(false)
    // Don't call onClose() here as that redirects away
  };

  const handleUseSuggestion = useCallback(() => {
    if (usernameSuggestion) {
      setLocalData((prev) => ({ ...prev, username: usernameSuggestion }));
    }
  }, [usernameSuggestion]);

  const isContinueDisabled =
    !localData.displayName.trim() ||
    !localData.username.trim() ||
    localData.username.length < 3 ||
    usernameStatus !== "available" ||
    isCheckingUsername;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-0 backdrop-blur-sm md:p-4">
      <div className="flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:max-w-2xl md:rounded-lg md:border md:border-border">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-border border-b bg-background px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button
              onClick={onClose}
              className="shrink-0 rounded-full p-2 transition-colors hover:bg-muted"
              aria-label="Close"
            >
              <XIcon className="h-5 w-5" />
            </button>
            <h2 className="truncate font-bold text-lg">Set Up Your Agent</h2>
          </div>
          <button
            onClick={handleContinue}
            disabled={isContinueDisabled}
            className={cn(
              "shrink-0 rounded-lg bg-[#0066FF] px-4 py-2 font-medium text-primary-foreground text-sm transition-colors hover:bg-[#2952d9]",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Continue
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {/* Cover Image Section */}
          <div className="space-y-2 p-4">
            <label className="block font-medium text-sm">Profile Banner</label>
            <div className="group relative h-40 overflow-hidden rounded-lg bg-muted">
              <img
                src={currentBanner}
                alt="Profile banner"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => cycleBanner("prev")}
                  className="rounded-lg bg-background/80 p-2 hover:bg-background"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <label className="cursor-pointer rounded-lg bg-background/80 p-2 hover:bg-background">
                  <Upload className="h-5 w-5" />
                  <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleBannerUpload}
                    className="hidden"
                    disabled={uploadingImage === "cover"}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => cycleBanner("next")}
                  className="rounded-lg bg-background/80 p-2 hover:bg-background"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
              {uploadingImage === "cover" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <span className="text-sm text-white">Uploading...</span>
                </div>
              )}
            </div>
          </div>

          {/* Profile Image Section */}
          <div className="flex items-start gap-4 px-4 pb-6">
            <div className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
              <img
                src={currentProfileImage}
                alt="Profile picture"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/50 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => cycleProfilePicture("prev")}
                  className="rounded-lg bg-background/80 p-1.5 hover:bg-background"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <label className="cursor-pointer rounded-lg bg-background/80 p-1.5 hover:bg-background">
                  <Upload className="h-4 w-4" />
                  <input
                    ref={profileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleProfileImageUpload}
                    className="hidden"
                    disabled={uploadingImage === "profile"}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => cycleProfilePicture("next")}
                  className="rounded-lg bg-background/80 p-1.5 hover:bg-background"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              {uploadingImage === "profile" && (
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
                  <span className="text-white text-xs">...</span>
                </div>
              )}
            </div>
            <div className="flex-1 pt-2 text-muted-foreground text-xs">
              <p>Use arrows to browse or click upload icon for custom image</p>
              <p>Max 5MB, JPG/PNG/GIF/WebP</p>
            </div>
          </div>

          {/* Form Fields */}
          <div className="space-y-5 px-4 pb-6">
            {/* Username */}
            <div>
              <label
                htmlFor="edit-username"
                className="mb-2 block font-medium text-sm"
              >
                Username *
              </label>
              <div
                className={cn(
                  "flex items-center rounded-lg border bg-muted focus-within:ring-2 focus-within:ring-[#0066FF]",
                  usernameStatus === "taken" && "border-red-500",
                  usernameStatus === "error" && "border-yellow-500",
                  usernameStatus === "available" && "border-green-500",
                  !usernameStatus && "border-border",
                )}
              >
                <span className="px-4 text-muted-foreground">@</span>
                <input
                  id="edit-username"
                  type="text"
                  value={localData.username}
                  onChange={(e) =>
                    setLocalData((prev) => ({
                      ...prev,
                      username: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, ""),
                    }))
                  }
                  maxLength={20}
                  className="w-full bg-transparent py-3 pr-10 focus:outline-none"
                  placeholder="agent_username"
                  aria-invalid={
                    usernameStatus === "taken" || usernameStatus === "error"
                  }
                  aria-describedby="username-status username-help"
                />
                {/* Status indicator */}
                <div className="pr-3">
                  {isCheckingUsername && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                  {!isCheckingUsername && usernameStatus === "available" && (
                    <Check className="h-4 w-4 text-green-500" />
                  )}
                  {!isCheckingUsername && usernameStatus === "taken" && (
                    <XIcon className="h-4 w-4 text-red-500" />
                  )}
                  {!isCheckingUsername && usernameStatus === "error" && (
                    <AlertCircle className="h-4 w-4 text-yellow-500" />
                  )}
                </div>
              </div>
              {/* Suggestion */}
              {usernameStatus === "taken" && usernameSuggestion && (
                <p className="mt-1.5 text-muted-foreground text-xs">
                  Username taken. Try:{" "}
                  <button
                    type="button"
                    onClick={handleUseSuggestion}
                    className="text-primary underline hover:text-primary/80"
                  >
                    {usernameSuggestion}
                  </button>
                </p>
              )}
              {/* Error with retry */}
              {usernameStatus === "error" && (
                <p className="mt-1.5 text-xs text-yellow-600">
                  Failed to check username.{" "}
                  <button
                    type="button"
                    onClick={retryCheck}
                    className="underline hover:text-yellow-500"
                  >
                    Retry
                  </button>
                </p>
              )}
              {localData.username && localData.username.length < 3 && (
                <p id="username-status" className="mt-1.5 text-red-500 text-xs">
                  Username must be at least 3 characters
                </p>
              )}
              <p
                id="username-help"
                className="mt-1.5 text-muted-foreground text-xs"
              >
                3-20 characters. Letters, numbers, and underscores only.
              </p>
            </div>

            {/* Display Name */}
            <div>
              <label
                htmlFor="edit-displayName"
                className="mb-2 block font-medium text-sm"
              >
                Display Name *
              </label>
              <input
                id="edit-displayName"
                type="text"
                value={localData.displayName}
                onChange={(e) =>
                  setLocalData((prev) => ({
                    ...prev,
                    displayName: e.target.value,
                  }))
                }
                className={cn(
                  "w-full rounded-lg border border-border bg-muted px-4 py-3",
                  "focus:outline-none focus:ring-2 focus:ring-[#0066FF]",
                )}
                placeholder="My Awesome Agent"
              />
            </div>

            {/* Bio */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="edit-bio" className="block font-medium text-sm">
                  Bio
                </label>
                <span className="text-muted-foreground text-xs">
                  {localData.bio?.length ?? 0}/{MAX_BIO_LENGTH}
                </span>
              </div>
              <textarea
                id="edit-bio"
                value={localData.bio ?? ""}
                onChange={(e) =>
                  setLocalData((prev) => ({ ...prev, bio: e.target.value }))
                }
                maxLength={MAX_BIO_LENGTH}
                rows={3}
                aria-describedby="bio-help"
                className={cn(
                  "w-full resize-none rounded-lg border border-border bg-muted px-4 py-3",
                  "focus:outline-none focus:ring-2 focus:ring-[#0066FF]",
                )}
                placeholder="A short description of your agent..."
              />
              <p id="bio-help" className="mt-1.5 text-muted-foreground text-xs">
                This will appear on your agent's profile.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
