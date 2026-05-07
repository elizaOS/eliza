/**
 * Profile form component for updating user profile information.
 * Supports name, avatar upload with preview, email updates, and displays organization role.
 *
 * @param props - Profile form configuration
 * @param props.user - User data with organization information
 */

"use client";

import {
  Alert,
  AlertDescription,
  Avatar,
  AvatarFallback,
  AvatarImage,
  BrandButton,
  BrandCard,
  CornerBrackets,
  Input,
} from "@elizaos/cloud-ui";
import Image from "@elizaos/cloud-ui/runtime/image";
import { Check, ImagePlus, Loader2, Mail, Shield, Upload, User, X } from "lucide-react";
import { useCallback, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import type { UserWithOrganizationDto } from "@/types/cloud-api";

interface ProfileActionResult {
  success: boolean;
  error?: string;
  message?: string;
}

interface AvatarUploadResult extends ProfileActionResult {
  avatarUrl?: string;
}

async function updateProfile(formData: FormData): Promise<ProfileActionResult> {
  const name = String(formData.get("name") ?? "");
  const avatar = String(formData.get("avatar") ?? "");

  const res = await fetch("/api/v1/user", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, avatar: avatar || undefined }),
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    message?: string;
  } | null;
  if (!res.ok || !body?.success) {
    return { success: false, error: body?.error ?? `Failed to update profile (${res.status})` };
  }
  return {
    success: true,
    message: body.message ?? "Profile updated successfully",
  };
}

async function updateEmail(formData: FormData): Promise<ProfileActionResult> {
  const email = String(formData.get("email") ?? "");

  const res = await fetch("/api/v1/user/email", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    message?: string;
  } | null;
  if (!res.ok || !body?.success) {
    return { success: false, error: body?.error ?? `Failed to update email (${res.status})` };
  }
  return {
    success: true,
    message: body.message ?? "Email added successfully",
  };
}

async function uploadAvatar(formData: FormData): Promise<AvatarUploadResult> {
  const res = await fetch("/api/v1/user/avatar", {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    reason?: string;
    message?: string;
    avatarUrl?: string;
  } | null;
  if (!res.ok || !body) {
    return {
      success: false,
      error: body?.error ?? body?.reason ?? `Failed to upload avatar (${res.status})`,
    };
  }
  if (body.success && typeof body.avatarUrl === "string") {
    return {
      success: true,
      avatarUrl: body.avatarUrl,
      message: body.message ?? "Avatar uploaded successfully",
    };
  }
  return { success: false, error: body.error ?? body.reason ?? "Failed to upload avatar" };
}

// Constants for validation
const VALID_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

interface ProfileFormProps {
  user: UserWithOrganizationDto;
}

export function ProfileForm({ user }: ProfileFormProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isUpdatingEmail, setIsUpdatingEmail] = useState(false);
  const [emailAdded, setEmailAdded] = useState(false);

  // Avatar preview states
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getInitials = (name: string | null, email: string | null, walletAddress: string | null) => {
    if (name) {
      return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    if (email) {
      return email.slice(0, 2).toUpperCase();
    }
    if (walletAddress) {
      return walletAddress.slice(0, 2).toUpperCase();
    }
    return "U";
  };

  // Validate and create preview for selected file
  const handleFileSelect = useCallback(
    (file: File) => {
      // Validate file type
      if (!VALID_IMAGE_TYPES.includes(file.type)) {
        toast.error("Invalid file type. Only JPEG, PNG, and WebP are allowed.");
        return;
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        toast.error("File too large. Maximum size is 5MB.");
        return;
      }

      // Clean up previous preview URL if exists
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }

      // Create preview URL and store pending file
      const objectUrl = URL.createObjectURL(file);
      setPreviewUrl(objectUrl);
      setPendingFile(file);
      setError(null);
    },
    [previewUrl],
  );

  // Handle file input change
  const handleAvatarSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
      // Reset input so same file can be selected again
      if (e.target) {
        e.target.value = "";
      }
    },
    [handleFileSelect],
  );

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        handleFileSelect(files[0]);
      }
    },
    [handleFileSelect],
  );

  // Cancel preview and discard pending file
  const handleCancelPreview = useCallback(() => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(null);
    setPendingFile(null);
  }, [previewUrl]);

  // Upload the pending file to server
  const handleSaveAvatar = async () => {
    if (!pendingFile) return;

    setIsUploadingAvatar(true);
    setError(null);

    const formData = new FormData();
    formData.append("file", pendingFile);

    const result = await uploadAvatar(formData);

    if (result.success) {
      toast.success(result.message || "Avatar uploaded successfully! 🔥");
      // Clean up preview
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      setPreviewUrl(null);
      setPendingFile(null);
      // Notify other components (like UserMenu) that avatar was updated
      window.dispatchEvent(new CustomEvent("user-avatar-updated"));
      window.location.reload();
    } else {
      setError(result.error || "Failed to upload avatar");
      toast.error(result.error || "Failed to upload avatar");
    }
    setIsUploadingAvatar(false);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      const result = await updateProfile(formData);

      if (result.success) {
        setSuccess(result.message || "Profile updated successfully");
        toast.success(result.message || "Profile updated successfully");
        window.location.reload();
      } else {
        setError(result.error || "Failed to update profile");
        toast.error(result.error || "Failed to update profile");
      }
    });
  };

  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsUpdatingEmail(true);

    const formData = new FormData(e.currentTarget);

    const result = await updateEmail(formData);

    if (result.success) {
      setSuccess(result.message || "Email added successfully");
      toast.success(result.message || "Email added successfully");
      setEmailAdded(true); // Optimistically hide the form
      window.location.reload();
    } else {
      setError(result.error || "Failed to add email");
      toast.error(result.error || "Failed to add email");
    }
    setIsUpdatingEmail(false);
  };

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <User className="h-5 w-5 text-[#FF5800]" />
            <h3 className="text-lg font-bold text-white">Profile Information</h3>
          </div>
          <p className="text-sm text-white/60">
            Update your profile information and manage your account settings
          </p>
        </div>

        {/* Email Section - Separate from main form to avoid nesting */}
        {!user.email && !emailAdded && (
          <div className="space-y-2 p-4 border border-amber-500/40 bg-amber-500/5 rounded-none">
            <div className="flex items-center gap-2 mb-3">
              <Mail className="h-4 w-4 text-amber-400" />
              <label
                htmlFor="new-email"
                className="text-xs font-medium text-amber-400 uppercase tracking-wide"
              >
                Add Email Address
              </label>
            </div>
            <p className="text-xs text-white/60 mb-3">
              Adding an email allows you to receive important notifications and updates.
            </p>
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              <Input
                id="new-email"
                name="email"
                type="email"
                placeholder="your@email.com"
                disabled={isUpdatingEmail}
                required
                className="rounded-none border-white/20 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-amber-500 focus:border-amber-500"
              />
              <BrandButton
                type="submit"
                variant="primary"
                size="sm"
                disabled={isUpdatingEmail}
                className="w-full"
              >
                {isUpdatingEmail ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Adding Email...
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4 mr-2 text-white" />
                    <p className="text-white">Add Email Address</p>
                  </>
                )}
              </BrandButton>
            </form>
          </div>
        )}

        {user.email && (
          <div className="space-y-2">
            <label
              htmlFor="email"
              className="text-xs font-medium text-white/70 uppercase tracking-wide flex items-center gap-2"
            >
              <Mail className="h-4 w-4" />
              Email Address
            </label>
            <Input
              id="email"
              type="email"
              value={user.email}
              disabled
              className="rounded-none border-white/10 bg-black/60 text-white/50"
            />
            <p className="text-xs text-white/50">
              Email cannot be changed. Please contact support if you need to update this.
            </p>
          </div>
        )}

        {emailAdded && !user.email && (
          <div className="space-y-2 p-4 border border-green-500/40 bg-green-500/5 rounded-none">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-green-400" />
              <p className="text-sm font-medium text-green-400">Email Added Successfully!</p>
            </div>
            <p className="text-xs text-white/60">
              Your email has been added and will appear here after the page refreshes.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Avatar Section */}
          <div className="flex flex-col sm:flex-row items-start gap-4 pb-6 border-b border-white/10">
            {/* Avatar Display with Preview */}
            <div className="relative group">
              {/* Show preview if pending, otherwise show current avatar */}
              {previewUrl ? (
                <div className="relative">
                  <div className="h-24 w-24 rounded-full overflow-hidden ring-2 ring-[#FF5800] ring-offset-2 ring-offset-black/50">
                    <Image
                      src={previewUrl}
                      alt="Preview"
                      width={96}
                      height={96}
                      className="h-full w-full object-cover"
                      unoptimized
                    />
                  </div>
                  {/* Preview badge */}
                  <div className="absolute -top-1 -right-1 bg-amber-500 text-black text-[10px] font-bold px-2 py-0.5 rounded-full animate-pulse">
                    PREVIEW
                  </div>
                </div>
              ) : (
                <Avatar className="h-24 w-24 ring-2 ring-[#FF5800] ring-offset-2 ring-offset-black/50">
                  <AvatarImage
                    src={user.avatar || undefined}
                    alt={
                      user.name ||
                      user.email ||
                      (user.wallet_address
                        ? `${user.wallet_address.substring(0, 6)}...${user.wallet_address.substring(user.wallet_address.length - 4)}`
                        : "User")
                    }
                  />
                  <AvatarFallback className="text-xl bg-gradient-to-br from-[#FF5800]/20 to-[#FF5800]/5">
                    {getInitials(user.name, user.email, user.wallet_address)}
                  </AvatarFallback>
                </Avatar>
              )}
            </div>

            <div className="flex-1 space-y-3">
              <div>
                <label className="text-xs font-medium text-white/70 uppercase tracking-wide">
                  Profile Picture
                </label>
                <p className="text-xs text-white/50 mt-1">
                  PNG, JPG or WEBP. Max 5MB. Drag & drop or click to upload.
                </p>
              </div>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                id="avatar-upload"
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                onChange={handleAvatarSelect}
                disabled={isUploadingAvatar}
                className="hidden"
              />

              {/* Show different UI based on whether we have a pending preview */}
              {previewUrl && pendingFile ? (
                // Preview mode: Show Save and Cancel buttons
                <div className="space-y-3">
                  <div className="flex items-center gap-2 p-3 rounded-lg border border-[#FF5800]/30 bg-[#FF5800]/5">
                    <div className="flex-1">
                      <p className="text-sm text-white font-medium truncate">{pendingFile.name}</p>
                      <p className="text-xs text-white/50">
                        {(pendingFile.size / 1024).toFixed(1)} KB
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <BrandButton
                      type="button"
                      variant="primary"
                      size="sm"
                      disabled={isUploadingAvatar}
                      onClick={handleSaveAvatar}
                      className="flex-1"
                    >
                      {isUploadingAvatar ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Check className="h-4 w-4 mr-2" />
                          Save Avatar
                        </>
                      )}
                    </BrandButton>
                    <BrandButton
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isUploadingAvatar}
                      onClick={handleCancelPreview}
                    >
                      <X className="h-4 w-4 mr-2" />
                      Cancel
                    </BrandButton>
                  </div>
                </div>
              ) : (
                // Normal mode: Show upload dropzone
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`flex items-center justify-center gap-3 p-4 rounded-lg border-2 border-dashed transition-all cursor-pointer ${
                    isDragging
                      ? "border-[#FF5800] bg-[#FF5800]/10"
                      : "border-white/20 hover:border-[#FF5800]/50 hover:bg-[#FF5800]/5"
                  }`}
                >
                  {isDragging ? (
                    <>
                      <ImagePlus className="h-5 w-5 text-[#FF5800]" />
                      <span className="text-sm font-medium text-[#FF5800]">
                        Drop your image here
                      </span>
                    </>
                  ) : (
                    <>
                      <Upload className="h-5 w-5 text-white/50" />
                      <span className="text-sm text-white/70">Click or drag image to upload</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Form Fields */}
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="name"
                className="text-xs font-medium text-white/70 uppercase tracking-wide"
              >
                Full Name <span className="text-rose-400">*</span>
              </label>
              <Input
                id="name"
                name="name"
                type="text"
                defaultValue={user.name || ""}
                placeholder="Enter your full name"
                required
                maxLength={100}
                disabled={isPending}
                className="rounded-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
              />
            </div>

            {user.wallet_address && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70 uppercase tracking-wide flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Wallet Address
                </label>
                <Input
                  type="text"
                  value={user.wallet_address}
                  disabled
                  className="rounded-none border-white/10 bg-black/60 text-white/50 font-mono text-xs"
                />
                {user.wallet_chain_type && (
                  <p className="text-xs text-white/50 capitalize">
                    Connected via {user.wallet_chain_type} wallet
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <label
                htmlFor="avatar"
                className="text-xs font-medium text-white/70 uppercase tracking-wide"
              >
                Avatar URL (Optional)
              </label>
              <Input
                id="avatar"
                name="avatar"
                type="url"
                defaultValue={user.avatar || ""}
                placeholder="https://example.com/avatar.jpg"
                disabled={isPending}
                className="rounded-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
              />
              <p className="text-xs text-white/50">
                Or use the upload button above to add a profile picture.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-white/70 uppercase tracking-wide flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Role
              </label>
              <Input
                type="text"
                value={user.role}
                disabled
                className="rounded-none border-white/10 bg-black/60 text-white/50 capitalize"
              />
              <p className="text-xs text-white/50">
                Your role in the organization. Contact an admin to change this.
              </p>
            </div>
          </div>

          {/* Messages */}
          {error && (
            <Alert variant="destructive" className="rounded-none border-rose-500/40 bg-rose-500/10">
              <AlertDescription className="text-rose-400">{error}</AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert className="rounded-none border-green-500/40 bg-green-500/10">
              <AlertDescription className="text-green-400">{success}</AlertDescription>
            </Alert>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-4">
            <BrandButton type="submit" variant="primary" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <p className="text-white">Save Changes</p>
              )}
            </BrandButton>
            <BrandButton
              type="button"
              variant="outline"
              onClick={() => window.location.reload()}
              disabled={isPending}
            >
              Cancel
            </BrandButton>
          </div>
        </form>
      </div>
    </BrandCard>
  );
}
