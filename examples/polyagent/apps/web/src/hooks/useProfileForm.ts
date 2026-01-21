"use client";

import { logger } from "@polyagent/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  ProfileFormState,
  UsernameStatus,
} from "@/components/waitlist/types";
import { useAuth } from "@/hooks/useAuth";

interface UseProfileFormOptions {
  userId: string | undefined;
  username: string | undefined;
  displayName: string | undefined;
  bio: string | undefined;
  profileImageUrl: string | undefined;
  coverImageUrl: string | undefined;
  showProfileModal: boolean;
  onProfileSaved: () => Promise<void>;
}

interface UseProfileFormReturn {
  profileForm: ProfileFormState;
  setProfileForm: React.Dispatch<React.SetStateAction<ProfileFormState>>;
  profilePictureIndex: number;
  bannerIndex: number;
  uploadedProfileImage: string | null;
  uploadedBanner: string | null;
  isSavingProfile: boolean;
  isCheckingUsername: boolean;
  usernameStatus: UsernameStatus;
  usernameSuggestion: string | null;
  cycleProfilePicture: (direction: "next" | "prev") => void;
  cycleBanner: (direction: "next" | "prev") => void;
  handleProfileImageUpload: (file: File) => Promise<void>;
  handleBannerUpload: (file: File) => Promise<void>;
  handleSaveProfile: () => Promise<void>;
  setUploadedProfileImage: React.Dispatch<React.SetStateAction<string | null>>;
  setUploadedBanner: React.Dispatch<React.SetStateAction<string | null>>;
}

const TOTAL_PROFILE_PICTURES = 100;
const TOTAL_BANNERS = 100;

export function useProfileForm({
  userId,
  username,
  displayName,
  bio,
  profileImageUrl,
  coverImageUrl,
  showProfileModal,
  onProfileSaved,
}: UseProfileFormOptions): UseProfileFormReturn {
  const { getAccessToken, refresh } = useAuth();

  const [profileForm, setProfileForm] = useState<ProfileFormState>({
    username: username || "",
    displayName: displayName || "",
    bio: bio || "",
    profileImageUrl: profileImageUrl || "",
    coverImageUrl: coverImageUrl || "",
  });

  const [profilePictureIndex, setProfilePictureIndex] = useState(1);
  const [bannerIndex, setBannerIndex] = useState(1);
  const [uploadedProfileImage, setUploadedProfileImage] = useState<
    string | null
  >(null);
  const [uploadedBanner, setUploadedBanner] = useState<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isCheckingUsername, setIsCheckingUsername] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>(null);
  const [usernameSuggestion, setUsernameSuggestion] = useState<string | null>(
    null,
  );

  const prevShowProfileModalRef = useRef(false);

  // Sync profile form with dbUser when modal opens
  useEffect(() => {
    if (showProfileModal) {
      const wasClosed = !prevShowProfileModalRef.current;
      if (wasClosed) {
        setProfileForm({
          username: username || "",
          displayName: displayName || "",
          bio: bio || "",
          profileImageUrl: profileImageUrl || "",
          coverImageUrl: coverImageUrl || "",
        });
        setUploadedProfileImage(null);
        setUploadedBanner(null);
        setUsernameStatus(null);
        setUsernameSuggestion(null);
      }
      prevShowProfileModalRef.current = true;
    } else {
      prevShowProfileModalRef.current = false;
    }
  }, [
    showProfileModal,
    username,
    displayName,
    bio,
    profileImageUrl,
    coverImageUrl,
  ]);

  // Real-time username validation
  useEffect(() => {
    if (!showProfileModal) return;

    const trimmedUsername = profileForm.username?.trim();

    if (!trimmedUsername || trimmedUsername.length < 3) {
      setUsernameStatus(null);
      setUsernameSuggestion(null);
      return;
    }

    if (trimmedUsername === username) {
      setUsernameStatus("available");
      setUsernameSuggestion(null);
      return;
    }

    let cancelled = false;

    const checkUsername = async () => {
      setIsCheckingUsername(true);

      try {
        const response = await fetch(
          `/api/onboarding/check-username?username=${encodeURIComponent(trimmedUsername)}`,
        );

        if (!cancelled && response.ok) {
          const result = await response.json();
          setUsernameStatus(result.available ? "available" : "taken");
          setUsernameSuggestion(
            result.available ? null : result.suggestion || null,
          );
        }
      } catch (error) {
        logger.warn(
          "Username availability check error",
          { error: error instanceof Error ? error.message : String(error) },
          "useProfileForm",
        );
      } finally {
        if (!cancelled) {
          setIsCheckingUsername(false);
        }
      }
    };

    const timeoutId = setTimeout(() => {
      void checkUsername();
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [profileForm.username, showProfileModal, username]);

  const cycleProfilePicture = useCallback((direction: "next" | "prev") => {
    setUploadedProfileImage(null);
    setProfilePictureIndex((prev) => {
      if (direction === "next") {
        return prev >= TOTAL_PROFILE_PICTURES ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_PROFILE_PICTURES : prev - 1;
    });
  }, []);

  const cycleBanner = useCallback((direction: "next" | "prev") => {
    setUploadedBanner(null);
    setBannerIndex((prev) => {
      if (direction === "next") {
        return prev >= TOTAL_BANNERS ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_BANNERS : prev - 1;
    });
  }, []);

  const handleProfileImageUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be less than 5MB");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", "profile");

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Upload failed");
      }

      const data = await response.json();
      setUploadedProfileImage(data.url);
      toast.success("Profile image uploaded!");
    } catch (error) {
      logger.error(
        "Profile image upload failed",
        { error: error instanceof Error ? error.message : String(error) },
        "useProfileForm",
      );
      toast.error("Failed to upload image");
    }
  }, []);

  const handleBannerUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error("Banner must be less than 10MB");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", "banner");

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Upload failed");
      }

      const data = await response.json();
      setUploadedBanner(data.url);
      toast.success("Banner uploaded!");
    } catch (error) {
      logger.error(
        "Banner upload failed",
        { error: error instanceof Error ? error.message : String(error) },
        "useProfileForm",
      );
      toast.error("Failed to upload banner");
    }
  }, []);

  const handleSaveProfile = useCallback(async () => {
    if (!userId) return;

    const trimmedUsername = profileForm.username?.trim();
    const trimmedDisplayName = profileForm.displayName?.trim();
    const trimmedBio = profileForm.bio?.trim();

    const finalProfileImageUrl =
      uploadedProfileImage ||
      profileForm.profileImageUrl?.trim() ||
      `/assets/user-profiles/profile-${profilePictureIndex}.jpg`;
    const finalCoverImageUrl =
      uploadedBanner ||
      profileForm.coverImageUrl?.trim() ||
      `/assets/user-banners/banner-${bannerIndex}.jpg`;

    if (!trimmedUsername || !trimmedDisplayName) {
      toast.error("Please fill in all required fields.");
      return;
    }

    if (usernameStatus === "taken") {
      toast.error("Username is already taken. Please choose another.");
      return;
    }

    setIsSavingProfile(true);
    try {
      const token = await getAccessToken();
      const response = await fetch(
        `/api/users/${encodeURIComponent(userId)}/update-profile`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            username: trimmedUsername,
            displayName: trimmedDisplayName,
            bio: trimmedBio,
            profileImageUrl: finalProfileImageUrl,
            coverImageUrl: finalCoverImageUrl,
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData?.error?.message ||
            errorData?.message ||
            "Failed to update profile",
        );
      }

      await refresh();
      await onProfileSaved();
      toast.success("Profile updated successfully!");
    } catch (error) {
      logger.error(
        "Error saving profile",
        { error: error instanceof Error ? error.message : String(error) },
        "useProfileForm",
      );
      toast.error(
        error instanceof Error ? error.message : "Failed to save profile",
      );
    } finally {
      setIsSavingProfile(false);
    }
  }, [
    userId,
    profileForm,
    uploadedProfileImage,
    uploadedBanner,
    profilePictureIndex,
    bannerIndex,
    usernameStatus,
    getAccessToken,
    refresh,
    onProfileSaved,
  ]);

  return {
    profileForm,
    setProfileForm,
    profilePictureIndex,
    bannerIndex,
    uploadedProfileImage,
    uploadedBanner,
    isSavingProfile,
    isCheckingUsername,
    usernameStatus,
    usernameSuggestion,
    cycleProfilePicture,
    cycleBanner,
    handleProfileImageUpload,
    handleBannerUpload,
    handleSaveProfile,
    setUploadedProfileImage,
    setUploadedBanner,
  };
}
