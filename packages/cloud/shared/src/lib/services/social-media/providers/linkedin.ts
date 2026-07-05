/**
 * LinkedIn Provider - UGC Post API
 */

import type {
  AccountAnalytics,
  MediaAttachment,
  PlatformPostOptions,
  PostAnalytics,
  PostContent,
  PostResult,
  SocialCredentials,
  SocialMediaProvider,
} from "../../../types/social-media";
import { extractErrorMessage } from "../../../utils/error-handling";
import { logger } from "../../../utils/logger";
import { withRetry } from "../rate-limit";

const LINKEDIN_API_BASE = "https://api.linkedin.com/v2";

interface LinkedInProfile {
  id: string;
  localizedFirstName?: string;
  localizedLastName?: string;
  profilePicture?: { displayImage: string };
}

interface LinkedInShareResponse {
  id: string;
  activity: string;
}

interface LinkedInUploadResponse {
  value: {
    uploadMechanism: {
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
        uploadUrl: string;
        headers: Record<string, string>;
      };
    };
    asset: string;
  };
}

async function linkedinApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${LINKEDIN_API_BASE}${endpoint}`;

  const { data } = await withRetry<T | { id: string }>(
    () =>
      fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
          ...options.headers,
        },
      }),
    async (response) => {
      if (response.status === 201) {
        const locationHeader = response.headers.get("x-restli-id");
        if (locationHeader) return { id: locationHeader };
      }
      const json = (await response.json()) as T & { message?: string; status?: number };
      if (json.message && json.status !== undefined && json.status >= 400)
        throw new Error(json.message);
      return json;
    },
    { platform: "linkedin", maxRetries: 3 },
  );

  return data as T;
}

async function getPersonUrn(accessToken: string): Promise<string> {
  const profile = await linkedinApiRequest<LinkedInProfile>("/me", accessToken);
  return `urn:li:person:${profile.id}`;
}

export const linkedinProvider: SocialMediaProvider = {
  platform: "linkedin",

  async validateCredentials(credentials: SocialCredentials) {
    if (!credentials.accessToken) {
      return { valid: false, error: "Access token required" };
    }

    try {
      const profile = await linkedinApiRequest<LinkedInProfile>("/me", credentials.accessToken);

      return {
        valid: true,
        accountId: profile.id,
        displayName: [profile.localizedFirstName, profile.localizedLastName]
          .filter(Boolean)
          .join(" "),
        avatarUrl: profile.profilePicture?.displayImage,
      };
    } catch (error) {
      // error-policy:J1 outbound LinkedIn /me lookup — a failed check is a designed invalid-credentials result the caller reads via `valid: false`, not a fabricated success.
      return {
        valid: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async createPost(
    credentials: SocialCredentials,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult> {
    if (!credentials.accessToken) {
      return {
        platform: "linkedin",
        success: false,
        error: "Access token required",
      };
    }

    try {
      // Get author URN (person or organization)
      let authorUrn: string;
      if (options?.linkedin?.organizationId) {
        authorUrn = `urn:li:organization:${options.linkedin.organizationId}`;
      } else {
        authorUrn = await getPersonUrn(credentials.accessToken);
      }

      logger.info("[LinkedIn] Creating post", {
        author: authorUrn,
        hasMedia: !!content.media?.length,
        hasLink: !!content.link,
      });

      // Determine visibility
      const visibility = options?.linkedin?.visibility || "PUBLIC";
      const visibilityConfig =
        visibility === "PUBLIC"
          ? { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" }
          : { "com.linkedin.ugc.MemberNetworkVisibility": "CONNECTIONS" };

      // Build UGC post
      const ugcPost: Record<string, unknown> = {
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: {
              text: content.text,
            },
            shareMediaCategory: "NONE",
          },
        },
        visibility: visibilityConfig,
      };

      // Handle link share
      if (content.link) {
        (ugcPost.specificContent as Record<string, unknown>)["com.linkedin.ugc.ShareContent"] = {
          shareCommentary: { text: content.text },
          shareMediaCategory: "ARTICLE",
          media: [
            {
              status: "READY",
              originalUrl: content.link,
              title: { text: content.linkTitle || content.link },
              description: content.linkDescription ? { text: content.linkDescription } : undefined,
            },
          ],
        };
      }

      // Handle image share
      else if (content.media?.length && content.media[0].type === "image") {
        const mediaAssets: Array<{
          status: string;
          media: string;
          title?: { text: string };
        }> = [];

        for (const media of content.media) {
          if (media.url) {
            // For URL-based images, we need to register and upload
            // Register upload
            const registerResponse = await linkedinApiRequest<LinkedInUploadResponse>(
              "/assets?action=registerUpload",
              credentials.accessToken,
              {
                method: "POST",
                body: JSON.stringify({
                  registerUploadRequest: {
                    recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
                    owner: authorUrn,
                    serviceRelationships: [
                      {
                        relationshipType: "OWNER",
                        identifier: "urn:li:userGeneratedContent",
                      },
                    ],
                  },
                }),
              },
            );

            const uploadUrl =
              registerResponse.value.uploadMechanism[
                "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
              ].uploadUrl;
            const asset = registerResponse.value.asset;

            // Download and upload the image. A non-OK download or upload must
            // surface: otherwise the asset below is marked READY and attached to
            // a published post that references bytes LinkedIn never received.
            const imageResponse = await fetch(media.url);
            if (!imageResponse.ok) {
              throw new Error(
                `LinkedIn image download failed for ${media.url}: ${imageResponse.status}`,
              );
            }
            const imageData = await imageResponse.arrayBuffer();

            const uploadResponse = await fetch(uploadUrl, {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                "Content-Type": media.mimeType,
              },
              body: imageData,
            });
            if (!uploadResponse.ok) {
              throw new Error(`LinkedIn asset upload failed: ${uploadResponse.status}`);
            }

            mediaAssets.push({
              status: "READY",
              media: asset,
              title: media.altText ? { text: media.altText } : undefined,
            });
          }
        }

        if (mediaAssets.length > 0) {
          (ugcPost.specificContent as Record<string, unknown>)["com.linkedin.ugc.ShareContent"] = {
            shareCommentary: { text: content.text },
            shareMediaCategory: "IMAGE",
            media: mediaAssets,
          };
        }
      }

      const response = await linkedinApiRequest<LinkedInShareResponse>(
        "/ugcPosts",
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify(ugcPost),
        },
      );

      // Extract the share ID
      const shareId = response.id || response.activity;

      return {
        platform: "linkedin",
        success: true,
        postId: shareId,
        postUrl: `https://www.linkedin.com/feed/update/${shareId}`,
      };
    } catch (error) {
      // error-policy:J1 outbound LinkedIn publish boundary — the failure surfaces as a typed `success: false` PostResult the caller must check, never a fabricated success.
      logger.error("[LinkedIn] Post failed", { error });
      return {
        platform: "linkedin",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async deletePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.accessToken) {
      return { success: false, error: "Access token required" };
    }

    try {
      await linkedinApiRequest(`/ugcPosts/${encodeURIComponent(postId)}`, credentials.accessToken, {
        method: "DELETE",
      });

      return { success: true };
    } catch (error) {
      // error-policy:J1 outbound LinkedIn delete boundary — failure surfaces as a typed `success: false` result the caller must check.
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async getPostAnalytics(
    credentials: SocialCredentials,
    postId: string,
  ): Promise<PostAnalytics | null> {
    if (!credentials.accessToken) {
      return null;
    }

    // Internal failures (auth, transport, parse) propagate so the caller can tell
    // a broken pipeline apart from the designed-empty result: only a missing
    // `elements[0]` — the post exists but has no recorded social actions — is null.
    const response = await linkedinApiRequest<{
      elements?: Array<{
        likesSummary?: { totalLikes: number };
        commentsSummary?: { totalComments: number };
      }>;
    }>(`/socialActions/${encodeURIComponent(postId)}`, credentials.accessToken);

    const element = response.elements?.[0];
    if (!element) return null;

    return {
      platform: "linkedin",
      postId,
      metrics: {
        likes: element.likesSummary?.totalLikes || 0,
        comments: element.commentsSummary?.totalComments || 0,
      },
      fetchedAt: new Date(),
    };
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    if (!credentials.accessToken) {
      return null;
    }

    // A failed /me lookup propagates rather than masquerading as a valid empty
    // metrics set. The successful result carries an intentionally empty `metrics`
    // because LinkedIn's basic API exposes no follower counts (Marketing API only).
    const profile = await linkedinApiRequest<LinkedInProfile>("/me", credentials.accessToken);

    return {
      platform: "linkedin",
      accountId: profile.id,
      metrics: {},
      fetchedAt: new Date(),
    };
  },

  async uploadMedia(credentials: SocialCredentials, media: MediaAttachment) {
    if (!credentials.accessToken) {
      throw new Error("Access token required");
    }

    // Get person URN for ownership
    const authorUrn = await getPersonUrn(credentials.accessToken);

    // Register upload
    const registerResponse = await linkedinApiRequest<LinkedInUploadResponse>(
      "/assets?action=registerUpload",
      credentials.accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          registerUploadRequest: {
            recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
            owner: authorUrn,
            serviceRelationships: [
              {
                relationshipType: "OWNER",
                identifier: "urn:li:userGeneratedContent",
              },
            ],
          },
        }),
      },
    );

    const uploadUrl =
      registerResponse.value.uploadMechanism[
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
      ].uploadUrl;
    const asset = registerResponse.value.asset;

    // Get image data
    let imageData: Uint8Array;
    if (media.data) {
      imageData = Uint8Array.from(media.data);
    } else if (media.base64) {
      imageData = Uint8Array.from(Buffer.from(media.base64, "base64"));
    } else if (media.url) {
      const response = await fetch(media.url);
      if (!response.ok) {
        throw new Error(`LinkedIn image download failed for ${media.url}: ${response.status}`);
      }
      imageData = new Uint8Array(await response.arrayBuffer());
    } else {
      throw new Error("No media data provided");
    }

    // A non-OK upload must surface: returning the asset URN as if it succeeded
    // would hand callers a media handle LinkedIn never actually stored.
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": media.mimeType,
      },
      body: Buffer.from(imageData),
    });
    if (!uploadResponse.ok) {
      throw new Error(`LinkedIn asset upload failed: ${uploadResponse.status}`);
    }

    return { mediaId: asset };
  },

  async replyToPost(
    credentials: SocialCredentials,
    postId: string,
    content: PostContent,
  ): Promise<PostResult> {
    if (!credentials.accessToken) {
      return {
        platform: "linkedin",
        success: false,
        error: "Access token required",
      };
    }

    try {
      const authorUrn = await getPersonUrn(credentials.accessToken);

      const response = await linkedinApiRequest<{ id: string }>(
        `/socialActions/${encodeURIComponent(postId)}/comments`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            actor: authorUrn,
            message: { text: content.text },
          }),
        },
      );

      return {
        platform: "linkedin",
        success: true,
        postId: response.id,
      };
    } catch (error) {
      // error-policy:J1 outbound LinkedIn comment boundary — failure surfaces as a typed `success: false` PostResult the caller must check.
      return {
        platform: "linkedin",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async likePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.accessToken) {
      return { success: false, error: "Access token required" };
    }

    try {
      const authorUrn = await getPersonUrn(credentials.accessToken);

      await linkedinApiRequest(
        `/socialActions/${encodeURIComponent(postId)}/likes`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            actor: authorUrn,
          }),
        },
      );

      return { success: true };
    } catch (error) {
      // error-policy:J1 outbound LinkedIn like boundary — failure surfaces as a typed `success: false` result the caller must check.
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },
};
