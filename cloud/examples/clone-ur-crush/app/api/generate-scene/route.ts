import { NextRequest } from "next/server";

/**
 * Generate full-body scene image using SeeDream v4
 * Takes character's face image and creates a full-body scene
 */
export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const {
      faceImageUrl,
      name,
      description,
      howYouMet,
      gender,
      sceneType = "fullbody",
    } = await req.json();

    if (!faceImageUrl) {
      return new Response(JSON.stringify({ success: false, error: "Face image URL required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const falKey = process.env.FAL_KEY;

    if (!falKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Image generation not available. Please configure FAL_KEY.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Build scene prompt based on description and how you met
    let scenePrompt = "";

    if (sceneType === "selfie") {
      // Bedroom selfie for post-login
      scenePrompt = `${name} taking a cute selfie in their cozy bedroom. Warm lighting, casual comfortable clothes, friendly smile. Phone camera POV, relaxed and natural.`;
    } else {
      // Full-body scene based on context
      const activity = extractActivity(description, howYouMet);
      scenePrompt = `Full body shot of ${name} ${activity}. Natural setting, candid pose, friendly expression, ${gender === "female" ? "feminine" : gender === "male" ? "masculine" : "androgynous"} presentation. High quality, photorealistic, natural lighting.`;
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const { fal } = await import("@fal-ai/client");
          fal.config({ credentials: falKey });

          console.log("Generating scene with SeeDream:", scenePrompt);

          try {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "progress", message: "Creating scene..." })}\n\n`,
              ),
            );
          } catch (e) {
            console.error("Controller error on initial progress:", e);
          }

          const result = await fal.subscribe("fal-ai/bytedance/seedream/v4/edit", {
            input: {
              prompt: scenePrompt,
              image_urls: [faceImageUrl], // Use character's face as ingredient
            },
            logs: false, // Disable logs to avoid onQueueUpdate issues
          });

          const imageUrl = result.data?.images?.[0]?.url;

          if (!imageUrl) {
            console.error("No image URL in SeeDream result");
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "error", error: "No image generated" })}\n\n`,
                ),
              );
            } catch (e) {
              console.error("Controller error on error event:", e);
            }
            controller.close();
            return;
          }

          console.log("✅ Scene generated successfully:", imageUrl);

          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "complete", imageUrl })}\n\n`),
            );
          } catch (e) {
            console.error("Controller error on complete event:", e);
          }

          controller.close();
        } catch (error) {
          console.error("SeeDream error:", error);
          const errorMessage = error instanceof Error ? error.message : "Generation failed";
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "error", error: errorMessage })}\n\n`),
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Error generating scene:", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to generate scene" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function extractActivity(description: string, howYouMet: string): string {
  const text = `${description} ${howYouMet}`.toLowerCase();

  // Extract activity from context
  if (text.includes("coffee")) return "at a coffee shop, holding a latte";
  if (text.includes("hik")) return "on a hiking trail, wearing outdoor gear";
  if (text.includes("gym") || text.includes("fitness")) return "at the gym, in workout clothes";
  if (text.includes("music") || text.includes("concert"))
    return "at a music venue, enjoying a show";
  if (text.includes("art") || text.includes("museum")) return "at an art gallery, admiring artwork";
  if (text.includes("beach") || text.includes("surf")) return "at the beach, casual summer outfit";
  if (text.includes("book") || text.includes("library")) return "in a cozy library, reading a book";
  if (text.includes("cook")) return "in a modern kitchen, cooking";
  if (text.includes("college") || text.includes("class"))
    return "on a college campus, carrying books";
  if (text.includes("park")) return "in a park, relaxed and happy";

  // Default
  return "in a casual setting, natural pose, friendly smile";
}
