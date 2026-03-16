/**
 * App Builder Image Upload API
 * 
 * Uploads images to Vercel Blob storage for persistent storage
 * and multimodal AI analysis in the app builder.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { uploadBase64Image } from "@/lib/blob";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

const ImageUploadSchema = z.object({
  // Base64 data URI (e.g., "data:image/png;base64,...")
  base64: z.string().min(1),
  // Original filename for reference
  filename: z.string().optional(),
});

const BatchUploadSchema = z.object({
  images: z.array(ImageUploadSchema).min(1).max(5),
});

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    const body = await request.json();
    const validationResult = BatchUploadSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        { status: 400 }
      );
    }

    const { images } = validationResult.data;

    // Upload all images in parallel
    const uploadPromises = images.map(async (img, index) => {
      try {
        // Generate a filename if not provided
        const filename = img.filename || `image-${Date.now()}-${index}.png`;
        
        const result = await uploadBase64Image(img.base64, {
          filename,
          folder: "app-builder/images",
          userId: user.id,
        });

        return {
          success: true,
          url: result.url,
          pathname: result.pathname,
          contentType: result.contentType,
          size: result.size,
        };
      } catch (error) {
        logger.error("Failed to upload image", {
          error: error instanceof Error ? error.message : "Unknown error",
          userId: user.id,
          index,
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Upload failed",
        };
      }
    });

    const results = await Promise.all(uploadPromises);

    // Check if any uploads failed
    const failedUploads = results.filter((r) => !r.success);
    if (failedUploads.length > 0) {
      logger.warn("Some image uploads failed", {
        userId: user.id,
        totalImages: images.length,
        failedCount: failedUploads.length,
      });
    }

    return NextResponse.json({
      success: true,
      images: results,
    });
  } catch (error) {
    logger.error("Error in image upload", { error });
    const message = error instanceof Error ? error.message : "Internal error";

    let status = 500;
    if (message.includes("Authentication") || message.includes("Unauthorized")) {
      status = 401;
    } else if (message.includes("Invalid")) {
      status = 400;
    }

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
