-- Add imageUrl column to Post table for article cover images
ALTER TABLE "Post" ADD COLUMN "imageUrl" text;

-- Add index for articles with images (for queries filtering by type='article' and imageUrl)
CREATE INDEX IF NOT EXISTS "Post_type_imageUrl_idx" ON "Post" ("type", "imageUrl");
