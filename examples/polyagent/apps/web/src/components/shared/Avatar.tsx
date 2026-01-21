"use client";

import { cn, sanitizeId } from "@polyagent/shared";
import { useEffect, useState } from "react";

/**
 * Props for the Avatar component.
 */
interface AvatarProps {
  /** Unique identifier for the avatar (used for image URL generation) */
  id?: string;
  /** Display name (used for initials fallback) */
  name?: string;
  /** Type of entity: 'actor', 'business', or 'user' */
  type?: "actor" | "business" | "user";
  /** Direct image source URL */
  src?: string;
  /** Alt text for accessibility */
  alt?: string;
  /** Size variant: 'sm', 'md', or 'lg' */
  size?: "sm" | "md" | "lg";
  /** Additional CSS classes */
  className?: string;
  /** Scale factor for image sizing */
  scaleFactor?: number;
  /** Image URL (alternative to src) */
  imageUrl?: string;
}

/**
 * Props for the GroupAvatar component.
 */
interface GroupAvatarProps {
  /** Array of group members with their avatar information */
  members: Array<{
    id: string;
    name: string;
    type?: "actor" | "business" | "user";
  }>;
  /** Size variant: 'sm', 'md', or 'lg' */
  size?: "sm" | "md" | "lg";
  /** Additional CSS classes */
  className?: string;
}

const sizeClasses = {
  sm: "w-8 h-8 text-xs",
  md: "w-10 h-10 text-sm",
  lg: "w-14 h-14 text-base",
};

/**
 * Avatar component for displaying user, actor, or business profile pictures.
 *
 * Supports multiple image sources with fallback to initials. Automatically
 * generates image URLs based on entity type and ID. Handles loading states
 * and error fallbacks gracefully.
 *
 * @param props - Avatar component props
 * @returns Avatar element with image or initials fallback
 *
 * @example
 * ```tsx
 * <Avatar
 *   id="123"
 *   name="Alice"
 *   type="user"
 *   size="lg"
 * />
 * ```
 */
export function Avatar({
  id,
  name,
  type = "actor",
  src,
  alt,
  size = "md",
  className,
  scaleFactor = 1,
  imageUrl,
}: AvatarProps) {
  const [primaryImageError, setPrimaryImageError] = useState(false);
  const [fallbackImageError, setFallbackImageError] = useState(false);

  // Check if ID is purely numeric (likely a snowflake ID without static image)
  const isNumericId = id && /^\d+$/.test(id);
  const sanitizedId = id && !isNumericId ? sanitizeId(id) : undefined;

  // Determine the image path to use:
  // 1. If src is provided directly (uploaded profile image), use it
  // 2. Otherwise, use imageUrl if provided
  // 3. Finally, construct from id (static actor/org image)
  // Note: Skip static images for numeric IDs (e.g., Discord snowflakes) as they
  // don't have corresponding image files - go straight to fallback
  let imagePath: string | undefined;
  let fallbackPath: string | undefined;

  if (src) {
    imagePath = src;
  } else if (imageUrl) {
    imagePath = imageUrl;
  } else if (sanitizedId) {
    if (type === "business") {
      imagePath = `/images/organizations/${sanitizedId}.jpg`;
    } else if (type === "user") {
      // User avatars should only use src/imageUrl props
      // Don't try to load static images for users
      imagePath = undefined;
    } else {
      imagePath = `/images/actors/${sanitizedId}.jpg`;
    }
  }

  // Generate deterministic fallback based on id - always generate for non-user types
  // This ensures a fallback even if src is provided but fails to load
  if (id) {
    // Hash the id to get a number between 1-100
    const hash = Array.from(id).reduce(
      (acc, char) => acc + char.charCodeAt(0),
      0,
    );
    const profileNum = (hash % 100) + 1;
    fallbackPath = `/assets/user-profiles/profile-${profileNum}.jpg`;
  }

  // Display name is alt (if provided) or name (if provided) or first letter of id
  const displayName = alt || name || (id ? id : "User");
  const initial = displayName.charAt(0).toUpperCase();

  // Reset error flags when source changes (props that affect image path)
  // biome-ignore lint/correctness/useExhaustiveDependencies: These ARE component props that should trigger the effect when changed
  useEffect(() => {
    setPrimaryImageError(false);
    setFallbackImageError(false);
  }, [src, imageUrl, id, type]);

  // Base sizes in rem
  const baseSizes = {
    sm: 2, // 32px
    md: 2.5, // 40px
    lg: 3.5, // 56px
  };

  const scaledSize = baseSizes[size] * scaleFactor;

  // Determine which image to show based on error states
  let currentImagePath: string | undefined;
  if (!primaryImageError && imagePath) {
    // Try primary image first
    currentImagePath = imagePath;
  } else if (!fallbackImageError && fallbackPath) {
    // If primary failed, try fallback
    currentImagePath = fallbackPath;
  }

  const hasImage = Boolean(currentImagePath);

  // Check if className includes w-full h-full (for containers that should fill parent)
  const shouldFillParent =
    className?.includes("w-full") && className?.includes("h-full");

  const handleImageError = () => {
    if (!primaryImageError) {
      // Primary image failed
      setPrimaryImageError(true);
    } else {
      // Fallback image failed
      setFallbackImageError(true);
    }
  };

  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-full bg-sidebar/40",
        hasImage ? "" : "bg-primary/20 font-bold text-primary",
        // Don't add size classes if shouldFillParent
        !shouldFillParent && sizeClasses[size],
        className,
      )}
      style={
        shouldFillParent
          ? {
              fontSize: `${scaleFactor}rem`,
            }
          : {
              width: `${scaledSize}rem`,
              height: `${scaledSize}rem`,
              fontSize: `${scaleFactor}rem`,
            }
      }
    >
      {hasImage ? (
        <img
          src={currentImagePath}
          alt={displayName}
          className="h-full w-full object-cover"
          onError={handleImageError}
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </div>
  );
}

/**
 * Group avatar component displaying multiple avatars in an overlapping layout.
 *
 * Shows up to 3 member avatars in an overlapping arrangement. If there's
 * only one member, displays a single avatar. If empty, shows a default
 * "G" placeholder.
 *
 * @param props - GroupAvatar component props
 * @returns Group avatar element with overlapping member avatars
 *
 * @example
 * ```tsx
 * <GroupAvatar
 *   members={[
 *     { id: '1', name: 'Alice', type: 'user' },
 *     { id: '2', name: 'Bob', type: 'user' }
 *   ]}
 *   size="md"
 * />
 * ```
 */
export function GroupAvatar({
  members,
  size = "md",
  className,
}: GroupAvatarProps) {
  // Show up to 3 members in overlapping squares
  const displayMembers = members.slice(0, 3);

  if (displayMembers.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-primary/20",
          sizeClasses[size],
          className,
        )}
      >
        <div className="font-bold text-primary">G</div>
      </div>
    );
  }

  if (displayMembers.length === 1) {
    const member = displayMembers[0];
    if (!member) {
      return (
        <div
          className={cn(
            "flex items-center justify-center bg-primary/20",
            sizeClasses[size],
            className,
          )}
        >
          <div className="font-bold text-primary">G</div>
        </div>
      );
    }
    return (
      <Avatar
        id={member.id}
        name={member.name}
        type={member.type}
        size={size}
        className={className}
      />
    );
  }

  // Overlapping avatars
  const overlappingSizeClasses = {
    sm: "w-6 h-6 text-[10px]",
    md: "w-8 h-8 text-xs",
    lg: "w-10 h-10 text-sm",
  };

  return (
    <div className={cn("relative flex items-center", className)}>
      {displayMembers.map((member, index) => (
        <div
          key={member.id}
          className={cn(
            "absolute flex items-center justify-center overflow-hidden border-2 border-background bg-primary/20",
            overlappingSizeClasses[size],
          )}
          style={{
            left: `${index * (size === "sm" ? 12 : size === "md" ? 16 : 20)}px`,
            zIndex: displayMembers.length - index,
          }}
        >
          <Avatar
            {...member}
            size={size === "lg" ? "md" : "sm"}
            className="h-full w-full border-0"
          />
        </div>
      ))}
      {/* Spacer to prevent content overlap */}
      <div
        className={cn(overlappingSizeClasses[size])}
        style={{
          marginRight: `${(displayMembers.length - 1) * (size === "sm" ? 12 : size === "md" ? 16 : 20)}px`,
        }}
      />
    </div>
  );
}
