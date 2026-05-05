declare module "@/app/actions/anonymous" {
  export function getOrCreateAnonymousUserAction(): Promise<{
    session?: {
      message_count?: number | null;
      messages_limit?: number | null;
      session_token?: string | null;
    } | null;
  }>;
}

declare module "@/app/actions/auth" {
  export function getCreditBalance(): Promise<number>;
}

declare module "@/app/actions/characters" {
  import type { ElizaCharacter } from "@/lib/types";

  export type UploadCharacterAvatarResult = {
    success: boolean;
    url?: string;
    error?: string;
  };

  export function uploadCharacterAvatar(formData: FormData): Promise<UploadCharacterAvatarResult>;
  export function createCharacter(elizaCharacter: ElizaCharacter): Promise<ElizaCharacter>;
  export function updateCharacter(
    characterId: string,
    elizaCharacter: ElizaCharacter,
  ): Promise<ElizaCharacter>;
  export function getCharacter(characterId: string): Promise<ElizaCharacter>;
}

declare module "@/app/actions/gallery" {
  export interface GalleryItem {
    id: string;
    type: "image" | "video";
    url: string;
    thumbnailUrl?: string;
    prompt: string;
    model: string;
    status: string;
    createdAt: Date;
    completedAt?: Date;
    dimensions?: {
      width?: number;
      height?: number;
      duration?: number;
    };
    mimeType?: string;
    fileSize?: bigint;
  }

  export function listUserMedia(options?: {
    type?: "image" | "video";
    limit?: number;
    offset?: number;
  }): Promise<GalleryItem[]>;
  export function deleteMedia(generationId: string): Promise<boolean>;
  export function listExploreImages(limit?: number): Promise<GalleryItem[]>;
  export function getUserMediaStats(): Promise<{
    totalImages: number;
    totalVideos: number;
    totalSize: number;
  }>;
}

declare module "@/app/actions/users" {
  export type ActionResult = {
    success: boolean;
    message?: string;
    error?: string;
    avatarUrl?: string;
  };

  export function updateProfile(formData: FormData): Promise<ActionResult>;
  export function updateEmail(formData: FormData): Promise<ActionResult>;
  export function uploadAvatar(formData: FormData): Promise<ActionResult>;
}

