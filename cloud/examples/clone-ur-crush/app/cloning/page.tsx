"use client";

import { Heart, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { APP_CONFIG, ROUTES } from "@/lib/constants";

export default function CloningPage() {
  const router = useRouter();
  const [dots, setDots] = useState("");
  const [error, setError] = useState("");
  const [characterPhoto, setCharacterPhoto] = useState<string | null>(null);
  const [characterName, setCharacterName] = useState<string>("");
  const [characterDescription, setCharacterDescription] = useState<string>("");
  const [progressStep, setProgressStep] = useState(0);

  useEffect(() => {
    // Animated dots
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 500);

    // Animate progress steps sequentially
    const progressInterval = setInterval(() => {
      setProgressStep((prev) => (prev < 2 ? prev + 1 : prev));
    }, 700);

    // Get character data from localStorage
    const sessionId = localStorage.getItem("cyc_session_id");
    const characterId = localStorage.getItem("cyc_character_id");
    const characterDataStr = localStorage.getItem("cyc_character_data");

    if (!characterId) {
      router.push(ROUTES.home);
      return () => clearInterval(interval);
    }

    // Parse character data for display
    if (characterDataStr) {
      try {
        const characterData = JSON.parse(characterDataStr);
        console.log("=== CLONING PAGE CHARACTER DATA ===");
        console.log("Full character data:", characterData);

        setCharacterName(characterData.name || "");

        // Get description from bio array
        if (characterData.bio && Array.isArray(characterData.bio)) {
          setCharacterDescription(characterData.bio[0] || "");
        }

        // Try to get photo from various possible sources
        const photoUrl = characterData.photoUrl || characterData.settings?.photoUrl || null;
        console.log("Character photo URL:", photoUrl);
        console.log("Has photoUrl:", !!photoUrl);
        setCharacterPhoto(photoUrl);

        if (!photoUrl) {
          console.warn("⚠️  No photo URL found in character data!");
        }
      } catch (e) {
        console.error("Failed to parse character data:", e);
      }
    }

    // Just create the character
    const initializeCharacter = async () => {
      await createCharacter();
    };

    // Create character in ElizaOS Cloud
    const createCharacter = async () => {
      try {
        // Get stored character data
        const characterDataStr = localStorage.getItem("cyc_character_data");
        if (!characterDataStr) {
          throw new Error("Character data not found");
        }

        const characterData = JSON.parse(characterDataStr);

        // Map photoUrl to avatar_url (Cloud schema expects avatar_url, not photoUrl)
        const {
          photoUrl,
          fullBodyImageUrl,
          system,
          username,
          knowledge,
          plugins,
          postExamples,
          ...cloudFields
        } = characterData;
        const cloudCharacter = {
          ...cloudFields,
          // Cloud affiliate schema expects avatar_url for the character image
          ...(photoUrl ? { avatar_url: photoUrl } : {}),
          // Preserve system prompt in settings since Cloud schema doesn't have top-level system field
          settings: {
            ...(cloudFields.settings || {}),
            ...(system ? { system } : {}),
          },
        };

        // Call ElizaOS Cloud affiliate API to create character
        // Requires Bearer API key with "affiliate:create-character" permission
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (APP_CONFIG.affiliateApiKey) {
          headers["Authorization"] = `Bearer ${APP_CONFIG.affiliateApiKey}`;
        }

        const response = await fetch(`${APP_CONFIG.elizaCloudUrl}/api/affiliate/create-character`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            character: cloudCharacter,
            affiliateId: "clone-your-crush",
            sessionId,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error("Cloud API error:", errorData);
          throw new Error(errorData.error || "Failed to create character in Cloud");
        }

        const result = await response.json();

        if (!result.success || !result.characterId) {
          throw new Error("Invalid response from Cloud");
        }

        // Re-read full-body image URL in case it was updated since the
        // initial destructure above.
        const finalCharacterData = localStorage.getItem("cyc_character_data");
        let freshFullBodyImageUrl = fullBodyImageUrl;
        if (finalCharacterData) {
          try {
            const parsed = JSON.parse(finalCharacterData);
            freshFullBodyImageUrl = parsed.fullBodyImageUrl;
          } catch (e) {
            console.error("Error parsing final character data:", e);
          }
        }

        // Redirect to ElizaOS Cloud chat page with images in URL params
        const cloudChatUrl = new URL(`${APP_CONFIG.elizaCloudUrl}/chat/${result.characterId}`);
        cloudChatUrl.searchParams.set("source", "clone-your-crush");
        cloudChatUrl.searchParams.set("session", sessionId || "");

        // Pass images via URL since localStorage won't work cross-origin
        if (characterData.photoUrl) {
          cloudChatUrl.searchParams.set("photoUrl", characterData.photoUrl);
        }
        if (freshFullBodyImageUrl) {
          cloudChatUrl.searchParams.set("fullBodyImageUrl", freshFullBodyImageUrl);
        }

        console.log(`Redirecting to Cloud: ${cloudChatUrl.toString()}`);

        // Small delay to show the animation
        setTimeout(() => {
          window.location.href = cloudChatUrl.toString();
        }, 2000);
      } catch (err) {
        console.error("Error creating character:", err);
        setError("Failed to create your character. Please try again.");
        setTimeout(() => {
          router.push(ROUTES.home);
        }, 3000);
      }
    };

    initializeCharacter();

    return () => {
      clearInterval(interval);
      clearInterval(progressInterval);
    };
  }, [router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-pink-50 via-purple-50 to-blue-50">
      {!error ? (
        /* Tinder-like Card Layout */
        <div className="min-h-screen flex flex-col md:flex-row md:items-center md:justify-center p-0 md:p-8">
          {/* Character Card */}
          <div className="relative w-full md:max-w-md h-screen md:h-[600px] md:rounded-3xl overflow-hidden shadow-2xl">
            {/* Background Image */}
            {characterPhoto ? (
              <img
                src={characterPhoto}
                alt={characterName}
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
                <Heart
                  className="w-32 h-32 text-primary/40 animate-pulse-glow"
                  fill="currentColor"
                />
              </div>
            )}

            {/* Gradient Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

            {/* Floating Hearts Animation */}
            <div className="absolute top-8 right-8 animate-pulse">
              <Heart className="w-12 h-12 text-white/80" fill="currentColor" />
            </div>

            {/* Content Overlay */}
            <div className="absolute inset-x-0 bottom-0 p-6 md:p-8">
              {/* Name and Description */}
              <div className="mb-6">
                <h1 className="text-4xl md:text-5xl font-bold text-white mb-3">
                  {characterName || "Your Crush"}
                  <span className="ml-3 text-pink-400 animate-pulse-glow">{dots}</span>
                </h1>
                {characterDescription && (
                  <p className="text-white/90 text-lg leading-relaxed line-clamp-3">
                    {characterDescription}
                  </p>
                )}
              </div>

              {/* Progress Steps - Sequential Chat-like Animation */}
              <div className="space-y-3 mb-6 min-h-[120px]">
                {progressStep >= 0 && (
                  <div
                    className={`flex items-center gap-3 bg-white/10 backdrop-blur-md rounded-xl p-3 transition-all duration-500 ${
                      progressStep > 0 ? "opacity-60 scale-95" : "opacity-100 scale-100"
                    }`}
                    style={{
                      animation: "slideInUp 0.4s ease-out",
                    }}
                  >
                    <Sparkles className="w-4 h-4 text-pink-300 flex-shrink-0 animate-spin" />
                    <span className="text-sm text-white/90">Analyzing personality</span>
                  </div>
                )}
                {progressStep >= 1 && (
                  <div
                    className={`flex items-center gap-3 bg-white/10 backdrop-blur-md rounded-xl p-3 transition-all duration-500 ${
                      progressStep > 1 ? "opacity-60 scale-95" : "opacity-100 scale-100"
                    }`}
                    style={{
                      animation: "slideInUp 0.4s ease-out",
                    }}
                  >
                    <Sparkles className="w-4 h-4 text-purple-300 flex-shrink-0 animate-spin" />
                    <span className="text-sm text-white/90">Creating AI companion</span>
                  </div>
                )}
                {progressStep >= 2 && (
                  <div
                    className="flex items-center gap-3 bg-white/10 backdrop-blur-md rounded-xl p-3 opacity-100 scale-100 transition-all duration-500"
                    style={{
                      animation: "slideInUp 0.4s ease-out",
                    }}
                  >
                    <Sparkles className="w-4 h-4 text-pink-300 flex-shrink-0 animate-spin" />
                    <span className="text-sm text-white/90">Setting up chat</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Error State */
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="text-center max-w-md">
            <Heart className="w-24 h-24 text-red-500 mx-auto mb-6" fill="currentColor" />
            <h1 className="text-3xl font-bold mb-4 text-red-600">Oops!</h1>
            <p className="text-lg text-gray-700 mb-4">{error}</p>
            <p className="text-sm text-gray-500">Redirecting you back to try again...</p>

            {/* Footer Branding */}
            <div className="mt-12">
              <p className="text-sm text-gray-600">
                A product of{" "}
                <a
                  href="https://elizaos.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary-dark font-medium transition-colors underline decoration-primary/30 hover:decoration-primary"
                  data-testid="eliza-labs-link"
                >
                  Eliza Labs
                </a>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
