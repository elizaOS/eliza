import { NextRequest, NextResponse } from "next/server";
import { getAIProvider } from "@/lib/ai-provider";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const photo = formData.get("photo") as File;

    if (!photo) {
      return NextResponse.json({ success: false, error: "No photo provided" }, { status: 400 });
    }

    const provider = getAIProvider();

    // Convert image to base64
    const bytes = await photo.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const base64Image = buffer.toString("base64");
    const mimeType = photo.type || "image/jpeg";

    // Use AI Vision API to analyze the photo
    const response = await fetch(provider.chatEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.visionModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Describe this person in 2-3 sentences. Focus on their physical appearance, style, and overall vibe. Be warm and descriptive, as if telling a friend about them.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`${provider.name} Vision API error:`, errorData);
      return NextResponse.json(
        { success: false, error: "Failed to analyze photo" },
        { status: 500 },
      );
    }

    const data = await response.json();
    const description = data.choices[0]?.message?.content || "";

    return NextResponse.json({
      success: true,
      description,
    });
  } catch (error) {
    console.error("Error analyzing photo:", error);
    return NextResponse.json({ success: false, error: "Failed to analyze photo" }, { status: 500 });
  }
}
