"use client";

import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Camera,
  Check,
  Key,
  Settings,
  TrendingUp,
  User,
  X as XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LoginButton } from "@/components/auth/LoginButton";
import { Avatar } from "@/components/shared/Avatar";
import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useOwnedAgents } from "@/hooks/useOwnedAgents";
import { useAuthStore } from "@/stores/authStore";

interface ProfileFormData {
  username: string;
  displayName: string;
  bio: string;
  profileImageUrl: string;
}

interface EditModalState {
  isOpen: boolean;
  formData: ProfileFormData;
  profileImage: { file: File | null; preview: string | null };
  isSaving: boolean;
  error: string | null;
}

export default function ProfilePage() {
  const { ready, authenticated, getAccessToken } = useAuth();
  const { user, setUser } = useAuthStore();
  const router = useRouter();
  const { agents, loading: agentsLoading } = useOwnedAgents(user?.id);

  const [formData, setFormData] = useState<ProfileFormData>({
    username: "",
    displayName: "",
    bio: "",
    profileImageUrl: "",
  });

  const [saveSuccess, setSaveSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editModal, setEditModal] = useState<EditModalState>({
    isOpen: false,
    formData: {
      username: "",
      displayName: "",
      bio: "",
      profileImageUrl: "",
    },
    profileImage: { file: null, preview: null },
    isSaving: false,
    error: null,
  });

  const profileImageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) {
      setFormData({
        username: user.username || "",
        displayName: user.displayName || "",
        bio: user.bio || "",
        profileImageUrl: user.profileImageUrl || "",
      });
      setLoading(false);
    } else if (ready) {
      setLoading(false);
    }
  }, [user, ready]);

  const openEditModal = () => {
    setEditModal({
      isOpen: true,
      formData: { ...formData },
      profileImage: { file: null, preview: null },
      isSaving: false,
      error: null,
    });
  };

  const closeEditModal = () => {
    setEditModal({
      isOpen: false,
      formData: {
        username: "",
        displayName: "",
        bio: "",
        profileImageUrl: "",
      },
      profileImage: { file: null, preview: null },
      isSaving: false,
      error: null,
    });
    if (profileImageInputRef.current) profileImageInputRef.current.value = "";
  };

  const handleProfileImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/gif",
    ];
    if (!allowedTypes.includes(file.type)) {
      setEditModal((prev) => ({
        ...prev,
        error: "Please select a valid image file",
      }));
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setEditModal((prev) => ({
        ...prev,
        error: "File size must be less than 10MB",
      }));
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setEditModal((prev) => ({
        ...prev,
        profileImage: { file, preview: reader.result as string },
        error: null,
      }));
    };
    reader.readAsDataURL(file);
  };

  const saveProfile = async () => {
    if (!user?.id) return;

    setEditModal((prev) => ({ ...prev, isSaving: true, error: null }));

    const token = await getAccessToken();
    const headers: HeadersInit = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    const updatedData = { ...editModal.formData };

    // Upload profile image if changed
    if (editModal.profileImage.file) {
      const formData = new FormData();
      formData.append("file", editModal.profileImage.file);
      formData.append("type", "profile");

      const uploadResponse = await fetch("/api/upload/image", {
        method: "POST",
        headers,
        body: formData,
      });

      if (!uploadResponse.ok) {
        setEditModal((prev) => ({
          ...prev,
          error: "Failed to upload profile image",
          isSaving: false,
        }));
        return;
      }
      const uploadData = await uploadResponse.json();
      updatedData.profileImageUrl = uploadData.url;
    }

    // Remove empty strings from updatedData
    Object.keys(updatedData).forEach((key) => {
      if (updatedData[key as keyof ProfileFormData] === "") {
        delete updatedData[key as keyof ProfileFormData];
      }
    });

    const updateResponse = await fetch(
      `/api/users/${encodeURIComponent(user.id)}/update-profile`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(updatedData),
      },
    );

    if (!updateResponse.ok) {
      const errorData = await updateResponse.json().catch(() => ({}));
      const errorMessage =
        errorData?.error?.message || "Failed to update profile";
      setEditModal((prev) => ({
        ...prev,
        error: errorMessage,
        isSaving: false,
      }));
      return;
    }
    const data = await updateResponse.json();

    setFormData({
      username: data.user.username,
      displayName: data.user.displayName,
      bio: data.user.bio,
      profileImageUrl: data.user.profileImageUrl,
    });

    setUser({
      ...user,
      username: data.user.username,
      displayName: data.user.displayName,
      bio: data.user.bio,
      profileImageUrl: data.user.profileImageUrl,
    });

    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
    closeEditModal();
  };

  // Loading state
  if (loading) {
    return (
      <PageContainer>
        <div className="mx-auto max-w-2xl space-y-6">
          <Skeleton className="h-8 w-32" />
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="flex items-start gap-4">
              <Skeleton className="h-24 w-24 rounded-full" />
              <div className="flex-1 space-y-3">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </PageContainer>
    );
  }

  // Not authenticated
  if (!authenticated || !user) {
    return (
      <PageContainer className="flex flex-col">
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <User className="mx-auto mb-4 h-16 w-16 text-muted-foreground" />
            <h2 className="mb-2 font-bold text-foreground text-xl">Sign In</h2>
            <p className="mb-6 text-muted-foreground">
              Sign in to view and edit your profile
            </p>
            <LoginButton />
          </div>
        </div>
      </PageContainer>
    );
  }

  const activeAgents = agents?.filter((a) => a.tradingEnabled)?.length ?? 0;
  const totalAgents = agents?.length ?? 0;

  return (
    <PageContainer>
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="rounded-full p-2 transition-colors hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="font-bold text-2xl">Profile</h1>
        </div>

        {/* Profile Card */}
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-start gap-4">
            {/* Avatar */}
            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-full border-4 border-background bg-muted">
              <Avatar
                id={user.id}
                name={formData.displayName || formData.username || ""}
                type="user"
                src={formData.profileImageUrl || undefined}
                size="lg"
                className="h-full w-full"
              />
            </div>

            {/* Info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-bold text-xl">
                    {formData.displayName || "Your Name"}
                  </h2>
                  <p className="text-muted-foreground">
                    @{formData.username || "username"}
                  </p>
                </div>
                <button
                  onClick={openEditModal}
                  className="rounded-lg border border-border bg-background px-4 py-2 font-medium text-sm transition-colors hover:bg-muted"
                >
                  Edit Profile
                </button>
              </div>
              {formData.bio && (
                <p className="mt-3 text-foreground">{formData.bio}</p>
              )}
            </div>
          </div>

          {/* Save Feedback */}
          {saveSuccess && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/10 p-3 text-green-400">
              <Check className="h-5 w-5" />
              <span className="font-medium text-sm">
                Profile updated successfully!
              </span>
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/agents"
            className="rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/50"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Bot className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-muted-foreground text-sm">Your Agents</p>
                <p className="font-semibold text-xl">{totalAgents}</p>
                <p className="text-muted-foreground text-xs">
                  {activeAgents} active
                </p>
              </div>
            </div>
          </Link>

          <Link
            href="/settings?tab=api"
            className="rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/50"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Key className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-muted-foreground text-sm">API Keys</p>
                <p className="font-semibold text-lg">Manage</p>
                <p className="text-muted-foreground text-xs">
                  For external integrations
                </p>
              </div>
            </div>
          </Link>
        </div>

        {/* Quick Links */}
        <div className="space-y-2">
          <h3 className="font-semibold text-lg">Quick Links</h3>
          <div className="space-y-2">
            <Link
              href="/settings"
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50"
            >
              <Settings className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Settings</p>
                <p className="text-muted-foreground text-sm">
                  Configure your account preferences
                </p>
              </div>
            </Link>
            <Link
              href="/agents/create"
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50"
            >
              <Bot className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Create New Agent</p>
                <p className="text-muted-foreground text-sm">
                  Deploy a new trading agent
                </p>
              </div>
            </Link>
            <a
              href="https://polymarket.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50"
            >
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Polymarket</p>
                <p className="text-muted-foreground text-sm">
                  Browse prediction markets
                </p>
              </div>
            </a>
          </div>
        </div>
      </div>

      {/* Edit Profile Modal */}
      {editModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background">
            {/* Header */}
            <div className="flex items-center justify-between border-border border-b px-4 py-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={closeEditModal}
                  disabled={editModal.isSaving}
                  className="rounded-full p-2 transition-colors hover:bg-muted disabled:opacity-50"
                  aria-label="Close"
                >
                  <XIcon className="h-5 w-5" />
                </button>
                <h2 className="font-bold text-lg">Edit Profile</h2>
              </div>
              <button
                onClick={saveProfile}
                disabled={editModal.isSaving}
                className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
              >
                {editModal.isSaving ? "Saving..." : "Save"}
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {/* Profile Image Section */}
              <div className="mb-6 flex justify-center">
                <div className="relative h-24 w-24">
                  {editModal.profileImage.preview ? (
                    <img
                      src={editModal.profileImage.preview}
                      alt="Profile preview"
                      className="h-full w-full rounded-full border-4 border-background object-cover"
                    />
                  ) : editModal.formData.profileImageUrl ? (
                    <img
                      src={editModal.formData.profileImageUrl}
                      alt="Profile"
                      className="h-full w-full rounded-full border-4 border-background object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center rounded-full border-4 border-background bg-primary/20">
                      <User className="h-12 w-12 text-primary" />
                    </div>
                  )}
                  <input
                    ref={profileImageInputRef}
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                    onChange={handleProfileImageSelect}
                    className="hidden"
                    disabled={editModal.isSaving}
                  />
                  <button
                    onClick={() => profileImageInputRef.current?.click()}
                    disabled={editModal.isSaving}
                    className="absolute right-0 bottom-0 rounded-full border-2 border-background bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                    aria-label="Change profile picture"
                  >
                    <Camera className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Form Fields */}
              <div className="space-y-4">
                {/* Error Message */}
                {editModal.error && (
                  <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-red-400">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="text-sm">{editModal.error}</span>
                  </div>
                )}

                {/* Display Name */}
                <div>
                  <label
                    htmlFor="displayName"
                    className="mb-2 block font-medium text-muted-foreground text-sm"
                  >
                    Display Name
                  </label>
                  <input
                    id="displayName"
                    type="text"
                    value={editModal.formData.displayName}
                    onChange={(e) =>
                      setEditModal((prev) => ({
                        ...prev,
                        formData: {
                          ...prev.formData,
                          displayName: e.target.value,
                        },
                      }))
                    }
                    placeholder="Your name"
                    className="w-full rounded-lg border border-border bg-muted/50 px-4 py-3 text-foreground focus:border-primary focus:outline-none"
                    disabled={editModal.isSaving}
                  />
                </div>

                {/* Username */}
                <div>
                  <label
                    htmlFor="username"
                    className="mb-2 block font-medium text-muted-foreground text-sm"
                  >
                    Username
                  </label>
                  <div className="flex items-center rounded-lg border border-border bg-muted/50 px-4 py-3 focus-within:border-primary">
                    <span className="text-muted-foreground">@</span>
                    <input
                      id="username"
                      type="text"
                      value={editModal.formData.username}
                      onChange={(e) =>
                        setEditModal((prev) => ({
                          ...prev,
                          formData: {
                            ...prev.formData,
                            username: e.target.value,
                          },
                        }))
                      }
                      placeholder="username"
                      className="flex-1 bg-transparent text-foreground focus:outline-none"
                      disabled={editModal.isSaving}
                    />
                  </div>
                </div>

                {/* Bio */}
                <div>
                  <label
                    htmlFor="bio"
                    className="mb-2 block font-medium text-muted-foreground text-sm"
                  >
                    Bio
                  </label>
                  <textarea
                    id="bio"
                    value={editModal.formData.bio}
                    onChange={(e) =>
                      setEditModal((prev) => ({
                        ...prev,
                        formData: {
                          ...prev.formData,
                          bio: e.target.value,
                        },
                      }))
                    }
                    placeholder="Tell us about yourself..."
                    rows={4}
                    maxLength={160}
                    className="w-full resize-none rounded-lg border border-border bg-muted/50 px-4 py-3 text-foreground focus:border-primary focus:outline-none"
                    disabled={editModal.isSaving}
                  />
                  <div className="mt-1 flex justify-end">
                    <span className="text-muted-foreground text-xs">
                      {editModal.formData.bio.length}/160
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
