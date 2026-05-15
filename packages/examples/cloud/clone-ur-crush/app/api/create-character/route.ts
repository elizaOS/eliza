import { NextRequest, NextResponse } from "next/server";
import { generateSessionId } from "@/lib/utils";
import { CreateCharacterResponse, ElizaCharacter } from "@/types";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const name = formData.get("name") as string;
    const description = formData.get("description") as string;
    const howYouMet = formData.get("howYouMet") as string;
    const photo = formData.get("photo") as File | null;
    const photoUrl = formData.get("photoUrl") as string | null;
    const physicalAppearance = formData.get("physicalAppearance") as string | null;

    // Speech examples
    const sayHello = formData.get("sayHello") as string | null;
    const sayGoodbye = formData.get("sayGoodbye") as string | null;
    const sayHowAreYou = formData.get("sayHowAreYou") as string | null;
    const sayGood = formData.get("sayGood") as string | null;
    const sayBad = formData.get("sayBad") as string | null;

    // Validate required fields
    if (!name || !description || !howYouMet) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: name, description, howYouMet" },
        { status: 400 },
      );
    }

    // Generate ElizaOS character
    const character = await generateCharacter({
      name,
      description,
      howYouMet,
      photo,
      photoUrl,
      physicalAppearance,
      speechExamples: {
        hello: sayHello,
        goodbye: sayGoodbye,
        howAreYou: sayHowAreYou,
        good: sayGood,
        bad: sayBad,
      },
    });

    // Generate session ID
    const sessionId = generateSessionId();
    const characterId = `char_${Date.now()}`;

    const response: CreateCharacterResponse = {
      characterId,
      sessionId,
      character,
    };

    return NextResponse.json({
      success: true,
      data: response,
    });
  } catch (error) {
    console.error("Error creating character:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create character" },
      { status: 500 },
    );
  }
}

async function generateCharacter(input: {
  name: string;
  description: string;
  howYouMet: string;
  photo: File | null;
  photoUrl: string | null;
  physicalAppearance: string | null;
  speechExamples: {
    hello: string | null;
    goodbye: string | null;
    howAreYou: string | null;
    good: string | null;
    bad: string | null;
  };
}): Promise<ElizaCharacter> {
  const { name, description, howYouMet, photoUrl, speechExamples } = input;

  // Extract topics from description and context
  const topics = extractTopics(description, howYouMet);

  // Generate conversation style adjectives based on description
  const adjectives = extractAdjectives(description, "");

  // Generate bio
  const bioArray = [description, `Context: ${howYouMet}`].filter((s) => s.length > 0);

  // Generate example messages using speech examples
  const messageExamples = generateMessageExamples(name, speechExamples);

  // System prompt
  const systemPrompt = `You are ${name}. ${description}
Context: ${howYouMet}

CRITICAL RULES:
- Keep ALL responses SHORT (1-2 sentences max)
- Text like a real person, NOT an AI assistant
- Be casual and natural
- DO NOT use emojis or hashtags
- DO NOT be overly helpful, formal, or assistant-like
- Respond like you're texting a friend
- Be spontaneous and authentic${
    Object.values(speechExamples).some((v) => v)
      ? "\n\nYour speaking style:\n" +
        Object.entries(speechExamples)
          .filter(([, v]) => v)
          .map(([k, v]) => `- ${k}: "${v}"`)
          .join("\n")
      : ""
  }`;

  // Build style guidelines based on speech examples
  const styleGuidelines = [
    "CRITICAL: Keep responses SHORT and CONCISE (1-2 sentences max)",
    "Be friendly and casual, not formal or assistant-like",
    "Use natural, conversational language like texting a friend",
    "Show genuine interest without being overly helpful",
    "Be authentic and spontaneous",
    "NO assistant-speak - you are NOT an AI helper, you are a real person",
    "Respond naturally like you would in a real conversation",
    "DO NOT use emojis or hashtags in your responses",
  ];

  if (Object.values(speechExamples).some((v) => v)) {
    styleGuidelines.push("Match the speaking style from the examples provided");
  }

  // Create ElizaOS character
  const character: ElizaCharacter = {
    name,
    username: name.toLowerCase().replace(/\s+/g, "_"),
    system: systemPrompt,
    bio: bioArray,
    messageExamples,
    postExamples: generatePostExamples(name, topics),
    topics,
    adjectives,
    knowledge: [],
    plugins: [],
    style: {
      all: styleGuidelines,
      chat: [
        "MAXIMUM 1-2 sentences per response - be brief!",
        "Text like a real person, not an AI assistant",
        "Use casual language - NO EMOJIS OR HASHTAGS",
        "Share quick thoughts and opinions",
        "Ask short follow-up questions sometimes",
        "Be spontaneous and real, not overly polite or formal",
        "NO long explanations or helpful assistant behavior",
        "Absolutely NO emojis (😊❤️etc) or hashtags (#)",
        Object.values(speechExamples).some((v) => v)
          ? "Match the speech examples - keep that vibe and length"
          : "",
      ].filter((s) => s.length > 0),
      post: ["Keep it short and casual", "Share genuine moments", "No emojis or hashtags"],
    },
    settings: {
      model: "gpt-5-mini",
      temperature: 0.8,
      maxTokens: 200,
      ...(photoUrl ? { photoUrl } : {}),
    },
  };

  return character;
}

function extractAdjectives(description: string, interests: string): string[] {
  const adjectives = ["friendly", "engaging", "thoughtful"];
  const text = `${description} ${interests}`.toLowerCase();

  if (text.includes("funny") || text.includes("humor")) adjectives.push("funny", "playful");
  if (text.includes("smart") || text.includes("intelligent"))
    adjectives.push("intelligent", "insightful");
  if (text.includes("kind") || text.includes("caring")) adjectives.push("kind", "caring");
  if (text.includes("creative") || text.includes("artistic"))
    adjectives.push("creative", "artistic");
  if (text.includes("adventurous") || text.includes("outdoors"))
    adjectives.push("adventurous", "energetic");
  if (text.includes("calm") || text.includes("relaxed")) adjectives.push("calm", "easygoing");
  if (text.includes("passionate") || text.includes("enthusiastic"))
    adjectives.push("passionate", "enthusiastic");

  return [...new Set(adjectives)];
}

function extractTopics(description: string, howYouMet: string): string[] {
  const topics: string[] = [];
  const text = `${description} ${howYouMet}`.toLowerCase();

  // Extract potential topics from text
  const topicKeywords = [
    "music",
    "movies",
    "books",
    "sports",
    "games",
    "travel",
    "food",
    "art",
    "photography",
    "fashion",
    "technology",
    "science",
    "nature",
    "coffee",
    "tea",
    "cooking",
    "fitness",
    "yoga",
    "meditation",
    "college",
    "work",
    "school",
    "university",
    "class",
  ];

  topicKeywords.forEach((keyword) => {
    if (text.includes(keyword)) {
      topics.push(keyword);
    }
  });

  return [...new Set(topics)];
}

function generateMessageExamples(
  name: string,
  speechExamples: {
    hello: string | null;
    goodbye: string | null;
    howAreYou: string | null;
    good: string | null;
    bad: string | null;
  },
): Array<Array<{ name: string; content: { text: string } }>> {
  const examples: Array<Array<{ name: string; content: { text: string } }>> = [];

  // Hello example
  if (speechExamples.hello) {
    examples.push([
      {
        name: "user",
        content: { text: "Hey!" },
      },
      {
        name,
        content: { text: speechExamples.hello },
      },
    ]);
  }

  // How are you example
  if (speechExamples.howAreYou) {
    examples.push([
      {
        name: "user",
        content: { text: "I'm good! How about you?" },
      },
      {
        name,
        content: { text: speechExamples.howAreYou },
      },
    ]);
  }

  // Good news example
  if (speechExamples.good) {
    examples.push([
      {
        name: "user",
        content: { text: "I just got an A on my test!" },
      },
      {
        name,
        content: { text: speechExamples.good },
      },
    ]);
  }

  // Bad news example
  if (speechExamples.bad) {
    examples.push([
      {
        name: "user",
        content: { text: "I had a really rough day..." },
      },
      {
        name,
        content: { text: speechExamples.bad },
      },
    ]);
  }

  // Goodbye example
  if (speechExamples.goodbye) {
    examples.push([
      {
        name: "user",
        content: { text: "I gotta go, talk later?" },
      },
      {
        name,
        content: { text: speechExamples.goodbye },
      },
    ]);
  }

  // Add default examples if none provided
  if (examples.length === 0) {
    examples.push([
      {
        name: "user",
        content: { text: `Hey ${name}!` },
      },
      {
        name,
        content: { text: "Hey! What's up?" },
      },
    ]);
  }

  return examples;
}

function generatePostExamples(name: string, topics: string[]): string[] {
  if (topics.length === 0) {
    return [
      "Just had the best day! Sometimes the simple moments are the best.",
      "Feeling grateful for all the good things in life 🙏",
      "Anyone else feel like time is flying by? Can't believe it's already this time of year!",
    ];
  }

  return topics.slice(0, 3).map((topic) => {
    const templates = [
      `Love spending time with ${topic}! It's my favorite way to unwind.`,
      `Can't get enough of ${topic} lately. Anyone else into this?`,
      `${topic.charAt(0).toUpperCase() + topic.slice(1)} day = best day! 🎉`,
    ];
    return templates[Math.floor(Math.random() * templates.length)];
  });
}
