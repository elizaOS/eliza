"use server";

import { revalidatePath } from "next/cache";
import { logger } from "@/lib/utils/logger";
import { requireAuth } from "@/lib/auth";
import { usersService } from "@/lib/services/users";
import { uploadToBlob } from "@/lib/blob";
import { z } from "zod";

const updateProfileSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  avatar: z.string().url("Invalid avatar URL").optional().or(z.literal("")),
});

const updateEmailSchema = z.object({
  email: z.string().email("Invalid email address"),
});

/**
 * Updates the authenticated user's profile (name and avatar).
 *
 * @param formData - Form data containing name and optional avatar URL.
 * @returns Success status with message, or error details if validation fails.
 */
export async function updateProfile(formData: FormData) {
  try {
    const user = await requireAuth();

    const data = {
      name: formData.get("name") as string,
      avatar: formData.get("avatar") as string,
    };

    // Validate input
    const validated = updateProfileSchema.parse(data);

    // Update user
    await usersService.update(user.id, {
      name: validated.name,
      avatar: validated.avatar || null,
    });

    // Revalidate cache
    revalidatePath("/dashboard/account");

    return {
      success: true,
      message: "Profile updated successfully",
    };
  } catch (error) {
    logger.error("Error updating profile:", error);

    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.issues[0].message,
      };
    }

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to update profile. Please try again.",
    };
  }
}

/**
 * Updates the authenticated user's email address.
 * Only allows updates if the user doesn't already have an email set.
 *
 * @param formData - Form data containing the new email address.
 * @returns Success status with message, or error if email is already set or in use.
 */
export async function updateEmail(formData: FormData) {
  try {
    const user = await requireAuth();

    // Only allow updating email if user doesn't have one
    if (user.email) {
      return {
        success: false,
        error:
          "Email already set. Please contact support to change your email.",
      };
    }

    const data = {
      email: formData.get("email") as string,
    };

    // Validate input
    const validated = updateEmailSchema.parse(data);

    // Check if email is already in use by another user
    const existingUser = await usersService.getByEmail(validated.email);
    if (existingUser && existingUser.id !== user.id) {
      return {
        success: false,
        error: "This email is already in use by another account.",
      };
    }

    // Update user email
    await usersService.update(user.id, {
      email: validated.email.toLowerCase().trim(),
      email_verified: false, // Will need to verify the new email
    });

    // Revalidate cache
    revalidatePath("/dashboard/account");

    return {
      success: true,
      message: "Email added successfully! Please check your inbox to verify.",
    };
  } catch (error) {
    logger.error("Error updating email:", error);

    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.issues[0].message,
      };
    }

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to update email. Please try again.",
    };
  }
}

/**
 * Uploads a user avatar image.
 * Validates file type (JPEG, PNG, WebP) and size (max 5MB).
 *
 * @param formData - Form data containing the avatar file.
 * @returns Success status with avatar URL, or error details if validation fails.
 */
export async function uploadAvatar(formData: FormData) {
  try {
    const user = await requireAuth();
    const file = formData.get("file") as File;

    if (!file) {
      return {
        success: false,
        error: "No file provided",
      };
    }

    // Validate file type
    const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!validTypes.includes(file.type)) {
      return {
        success: false,
        error: "Invalid file type. Only JPEG, PNG, and WebP are allowed.",
      };
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      return {
        success: false,
        error: "File too large. Maximum size is 5MB.",
      };
    }

    // Convert File to Buffer for upload
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Generate filename with extension from mime type
    const ext = file.type.split("/")[1] || "jpg";
    const filename = `avatar.${ext}`;

    // Upload to Vercel Blob storage
    const result = await uploadToBlob(buffer, {
      filename,
      contentType: file.type,
      folder: "avatars",
      userId: user.id,
    });

    const avatarUrl = result.url;

    await usersService.update(user.id, {
      avatar: avatarUrl,
    });

    revalidatePath("/dashboard/account");

    return {
      success: true,
      avatarUrl,
      message: "Avatar uploaded successfully",
    };
  } catch (error) {
    logger.error("Error uploading avatar:", error);

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to upload avatar. Please try again.",
    };
  }
}
