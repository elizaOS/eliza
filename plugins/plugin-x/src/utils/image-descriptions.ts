/**
 * `describeTweetPhotos` — runs each of a tweet's photos through the IMAGE_DESCRIPTION
 * model and returns them as described image `Media` attachments, so the interaction
 * and timeline loops can reason about pictured content. No-ops when the tweet has no
 * photos, no IMAGE_DESCRIPTION model is registered, or `DISABLE_IMAGE_DESCRIPTION` is set.
 */
import {
  type ContentType,
  type IAgentRuntime,
  type Media,
  ModelType,
} from "@elizaos/core";
import type { Tweet } from "../client/tweets";

const DISABLE_VALUES = new Set(["1", "true", "yes", "on"]);
// `ContentType.IMAGE` (the runtime const) is imported as a type only — the
// matching literal keeps Media.contentType strongly typed without depending on
// the value-side enum, which the plugin's vitest source-resolution leaves
// undefined for `primitives.ts` consts.
const IMAGE_CONTENT_TYPE: ContentType = "image";

/**
 * Whether the runtime can describe images. Mirrors the Discord connector's
 * gate: a registered `IMAGE_DESCRIPTION` model and no explicit opt-out via
 * `DISABLE_IMAGE_DESCRIPTION`.
 */
function isImageDescriptionEnabled(runtime: IAgentRuntime): boolean {
  const disabled = runtime.getSetting("DISABLE_IMAGE_DESCRIPTION");
  if (
    disabled === true ||
    (typeof disabled === "string" &&
      DISABLE_VALUES.has(disabled.trim().toLowerCase()))
  ) {
    return false;
  }
  return typeof runtime.getModel(ModelType.IMAGE_DESCRIPTION) === "function";
}

function isRemoteImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Run the `IMAGE_DESCRIPTION` model over every photo attached to a tweet and
 * return them as elizaOS `Media` attachments. The description is stored on both
 * `description` and `text` so the core `attachments` provider and the
 * `recentMessages` rendering surface it to the agent — letting the agent "see"
 * images posted on X, the same way the Discord connector does.
 *
 * Returns an empty array when the tweet has no photos or no `IMAGE_DESCRIPTION`
 * model is registered. A photo whose description fails still yields a `Media`
 * record (so the agent knows an image exists) but without descriptive text.
 */
export async function describeTweetPhotos(
  runtime: IAgentRuntime,
  tweet: Pick<Tweet, "photos">,
): Promise<Media[]> {
  const photos = tweet.photos ?? [];
  if (photos.length === 0 || !isImageDescriptionEnabled(runtime)) {
    return [];
  }

  const described = await Promise.all(
    photos.map(async (photo): Promise<Media | null> => {
      if (!photo.url || !isRemoteImageUrl(photo.url)) {
        return null;
      }

      try {
        const { description, title } = await runtime.useModel(
          ModelType.IMAGE_DESCRIPTION,
          photo.url,
        );
        const text = description || photo.alt_text || "";
        return {
          id: photo.id,
          url: photo.url,
          title: title || "Image Attachment",
          source: "twitter",
          contentType: IMAGE_CONTENT_TYPE,
          description: description || photo.alt_text || "An image attachment",
          text,
        };
      } catch (error) {
        runtime.logger.error(
          {
            src: "plugin:x",
            agentId: runtime.agentId,
            photoId: photo.id,
            url: photo.url,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error describing tweet image attachment",
        );
        return {
          id: photo.id,
          url: photo.url,
          title: "Image Attachment",
          source: "twitter",
          contentType: IMAGE_CONTENT_TYPE,
          description:
            photo.alt_text || "An image attachment (recognition failed)",
          text: photo.alt_text || "",
        };
      }
    }),
  );

  return described.filter((media): media is Media => media !== null);
}
