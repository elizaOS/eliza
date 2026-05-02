import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const { appearance, name } = await req.json();

    if (!appearance) {
      return new Response(
        JSON.stringify({ success: false, error: "Physical appearance description required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const falKey = process.env.FAL_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!falKey && !openaiKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Image generation not available. Please configure FAL_KEY or OPENAI_API_KEY.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Create portrait prompt
    const prompt = `Professional portrait photo of ${name || "a person"}. ${appearance}. High quality, natural lighting, friendly expression, realistic photographic style.`;

    // Use Fal if available (preferred - faster and better quality with streaming)
    if (falKey) {
      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Import fal client
            const { fal } = await import("@fal-ai/client");

            console.log("Using Fal.stream() for real-time image generation");

            // Configure with credentials
            fal.config({ credentials: falKey });

            // Send initial progress
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "progress", message: "Starting generation..." })}\n\n`,
              ),
            );

            // Use stream() to get intermediate image updates
            const falStream = await fal.stream("fal-ai/flux/krea", {
              input: {
                prompt,
                image_size: "square",
                num_inference_steps: 28,
                guidance_scale: 3.5,
              },
            });

            // Stream intermediate images as they generate
            let eventCount = 0;
            for await (const event of falStream) {
              eventCount++;
              console.log(`Fal stream event #${eventCount}:`, event);

              // The event IS the data - it contains images directly
              if (event.images?.[0]?.url) {
                const intermediateUrl = event.images[0].url;
                console.log("Sending intermediate image:", intermediateUrl);
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "image", imageUrl: intermediateUrl })}\n\n`,
                  ),
                );
              } else {
                console.log("Event did not contain image data, keys:", Object.keys(event));
              }
            }

            console.log(`Total stream events received: ${eventCount}`);

            // Get final result
            const result = await falStream.done();
            console.log("Fal final result:", result);

            // The result structure is { images: [...] }, not { data: { images: [...] } }
            const imageUrl = result.images?.[0]?.url;

            if (!imageUrl) {
              console.error("No image URL in final result. Result:", result);
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "error", error: "No image URL in response" })}\n\n`,
                ),
              );
              controller.close();
              return;
            }

            console.log("Final image URL:", imageUrl);

            // Send final complete event
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "complete", imageUrl })}\n\n`),
            );
            controller.close();
          } catch (error) {
            console.error("Fal streaming error:", error);
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
    }

    // Fallback to OpenAI DALL-E (non-streaming)
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "standard",
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("DALL-E API error:", errorData);
      return new Response(JSON.stringify({ success: false, error: "Failed to generate photo" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const imageUrl = data.data[0]?.url;

    if (!imageUrl) {
      return new Response(JSON.stringify({ success: false, error: "No image generated" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, imageUrl }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error generating photo:", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to generate photo" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
