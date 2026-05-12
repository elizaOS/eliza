import { NextRequest, NextResponse } from "next/server";
import { getAIProvider } from "@/lib/ai-provider";

export async function POST(req: NextRequest) {
  try {
    const { fieldName, currentValue, context } = await req.json();

    if (!fieldName) {
      return NextResponse.json({ success: false, error: "Field name required" }, { status: 400 });
    }

    const provider = getAIProvider();

    // Build context-aware prompt
    const prompt = buildPromptForField(fieldName, currentValue, context);

    // Build system prompt with character consistency note
    const systemPrompt =
      fieldName === "name"
        ? "You are a helpful assistant that generates realistic, natural character descriptions and dialogue. Be concise and authentic."
        : `You are a helpful assistant that generates realistic, natural character descriptions and dialogue. Be concise and authentic.

IMPORTANT: You are working with a SINGLE character. The character's name may have changed from previous context, but it's still the SAME person. If the name in the current context differs from previous descriptions, USE THE NEW NAME and rewrite/adapt the content for that character as if that was always their name. Maintain consistency with their personality, appearance, and traits, just update any name references.`;

    // Generate using AI provider (Groq or OpenAI)
    const response = await fetch(provider.chatEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.chatModel,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.8,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`${provider.name} API error:`, errorData);
      return NextResponse.json(
        { success: false, error: "Failed to generate field" },
        { status: 500 },
      );
    }

    const data = await response.json();
    const generatedValue = data.choices[0]?.message?.content?.trim() || "";

    // Clean up quotes if it's a speech example
    const cleanedValue = generatedValue.replace(/^["']|["']$/g, "");

    return NextResponse.json({
      success: true,
      value: cleanedValue,
    });
  } catch (error) {
    console.error("Error generating field:", error);
    return NextResponse.json(
      { success: false, error: "Failed to generate field" },
      { status: 500 },
    );
  }
}

function buildPromptForField(
  fieldName: string,
  currentValue: string | undefined,
  context: Record<string, string | undefined>,
): string {
  const hasContext = Object.values(context).some((v) => v && v.length > 0);
  const hasCurrentValue = currentValue && currentValue.length > 0;

  // Get gender pronoun
  const gender = context.gender || "nonbinary";
  const pronouns = gender === "male" ? "he/him" : gender === "female" ? "she/her" : "they/them";
  const genderNote = `Gender: ${gender} (${pronouns})`;

  // Build context summary
  let contextSummary = "";
  if (context.name) contextSummary += `Name: ${context.name}\n`;
  contextSummary += `${genderNote}\n`;
  if (context.description) contextSummary += `Description: ${context.description}\n`;
  if (context.howYouMet) contextSummary += `How you met: ${context.howYouMet}\n`;

  switch (fieldName) {
    case "description":
      if (hasCurrentValue) {
        return `Complete or enhance this description of ${context.name || "this person"} (${pronouns}):\n"${currentValue}"\n${
          contextSummary ? `\nContext:\n${contextSummary}` : ""
        }\nProvide a natural, complete description (2-3 sentences). ONLY describe ${context.name || "this person"} - do not mention or introduce any other people. Just return the enhanced text, no quotes or explanations.`;
      }
      return `Write a brief, natural description (2-3 sentences) of ${context.name || "a person"} (${pronouns})${
        hasContext ? ` based on this context:\n${contextSummary}` : ""
      }. 

CRITICAL: Describe ONLY ${context.name || "this person"}. Do not mention, introduce, or reference any other people, friends, or characters. Focus solely on ${context.name || "this person"}'s personality, appearance, and vibe. Be gender-appropriate for ${pronouns}. 

Just return the description, no quotes or explanations.`;

    case "howYouMet":
      if (hasCurrentValue) {
        return `Complete or enhance this story of how the user met ${context.name || "them"} (${pronouns}):\n"${currentValue}"\n${
          context.name ? `${context.name}'s name: ${context.name} (${pronouns})\n` : ""
        }${context.description ? `About ${context.name || "them"}: ${context.description}\n` : ""}

CRITICAL: This story is about how THE USER met ${context.name || "this person"}. Write from the user's perspective about meeting ${context.name || "them"}. Do not introduce other characters. Just return the enhanced text, no quotes or explanations.`;
      }
      return `Write a brief, natural story (2-3 sentences) about how THE USER met ${context.name || "a person"} (${pronouns})${
        context.description
          ? `. ${context.name || "They"} is described as: ${context.description}`
          : ""
      }. 

CRITICAL: This is about how THE USER met ${context.name || "this person"}. Write from the user's perspective. Do NOT introduce additional characters or friends. The story is ONLY about the user meeting ${context.name || "this person"}. Make it realistic and relatable.

Just return the story, no quotes or explanations.`;

    case "sayHello":
      return `How would ${context.name || "someone"}${
        context.description ? ` (${context.description.slice(0, 50)}...)` : ""
      } say "hello" casually to a friend?${
        hasCurrentValue ? `\nCurrent: "${currentValue}"\nImprove or complete it.` : ""
      } Just return the greeting, nothing else.`;

    case "sayGoodbye":
      return `How would ${context.name || "someone"}${
        context.description ? ` (${context.description.slice(0, 50)}...)` : ""
      } say "goodbye" casually to a friend?${
        hasCurrentValue ? `\nCurrent: "${currentValue}"\nImprove or complete it.` : ""
      } Just return the goodbye phrase, nothing else.`;

    case "sayHowAreYou":
      return `How would ${context.name || "someone"}${
        context.description ? ` (${context.description.slice(0, 50)}...)` : ""
      } ask "how are you?" casually?${
        hasCurrentValue ? `\nCurrent: "${currentValue}"\nImprove or complete it.` : ""
      } Just return the question, nothing else.`;

    case "sayGood":
      return `What would ${context.name || "someone"}${
        context.description ? ` (${context.description.slice(0, 50)}...)` : ""
      } say when hearing good news?${
        hasCurrentValue ? `\nCurrent: "${currentValue}"\nImprove or complete it.` : ""
      } Just return the response, nothing else.`;

    case "sayBad":
      return `What would ${context.name || "someone"}${
        context.description ? ` (${context.description.slice(0, 50)}...)` : ""
      } say when hearing bad news or something unfortunate?${
        hasCurrentValue ? `\nCurrent: "${currentValue}"\nImprove or complete it.` : ""
      } Just return the response, nothing else.`;

    case "physicalAppearance":
      return `Based on this character description: "${context.description}"

Character: ${context.name || "person"} (${pronouns})
      
Extract or infer the physical appearance details suitable for generating a portrait photo. Include:
- Hair color and style
- Eye color
- Facial features
- Build/body type (appropriate for ${gender} presentation)
- Style/fashion sense
- Any distinctive physical characteristics

Keep it concise (2-3 sentences) and focused only on visual/physical details that would help an AI generate their portrait photo. Do not include personality traits.
Make sure the physical description is appropriate for a ${gender} person.

Just return the physical description, nothing else.`;

    default:
      return `Generate a value for ${fieldName}${hasContext ? ` using this context:\n${contextSummary}` : ""}.`;
  }
}
