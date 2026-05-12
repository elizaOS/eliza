"use client";

import { Dices, RefreshCw, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ROUTES } from "@/lib/constants";
import { getRandomName } from "@/lib/random-names";
import { CharacterFormData } from "@/types";

const STORAGE_KEY = "cyc_form_draft";

type Gender = "male" | "female" | "nonbinary";

export default function HomePage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [gender, setGender] = useState<Gender>("female");
  const [formData, setFormData] = useState<CharacterFormData>({
    name: "",
    description: "",
    howYouMet: "",
    sayHello: "Hey babe!",
    sayGoodbye: "Miss you already 💕",
    sayHowAreYou: "How's your day going?",
    sayGood: "That's amazing! So proud of you!",
    sayBad: "Aw babe... wanna talk about it?",
  });
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [physicalAppearance, setPhysicalAppearance] = useState("");
  const [generatingPhoto, setGeneratingPhoto] = useState(false);
  const [generatingField, setGeneratingField] = useState<string | null>(null);
  const [shouldAutoGeneratePhoto, setShouldAutoGeneratePhoto] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);

  const totalSteps = 5;

  // Load form data from localStorage on mount
  useEffect(() => {
    try {
      const savedData = localStorage.getItem(STORAGE_KEY);
      if (savedData) {
        const parsed = JSON.parse(savedData);
        if (parsed.formData) setFormData(parsed.formData);
        if (parsed.photoPreview) setPhotoPreview(parsed.photoPreview);
        if (parsed.physicalAppearance) setPhysicalAppearance(parsed.physicalAppearance);
        if (parsed.gender) setGender(parsed.gender);
      }
    } catch (error) {
      console.error("Error loading saved form data:", error);
    }
    setIsInitialized(true);
  }, []);

  // Save form data to localStorage whenever it changes
  useEffect(() => {
    if (!isInitialized) return; // Don't save during initial load

    try {
      const dataToSave = {
        formData,
        photoPreview,
        physicalAppearance,
        gender,
        timestamp: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
    } catch (error) {
      console.error("Error saving form data:", error);
    }
  }, [formData, photoPreview, physicalAppearance, gender, isInitialized]);

  const handleGeneratePhoto = async () => {
    // Need description to generate from
    if (!formData.description.trim()) {
      alert("Please fill in the description first!");
      return;
    }

    // Always regenerate physical appearance for variation
    setGeneratingPhoto(true);
    try {
      const response = await fetch("/api/generate-field", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fieldName: "physicalAppearance",
          currentValue: "",
          context: {
            name: formData.name,
            gender: gender,
            description: formData.description,
            howYouMet: formData.howYouMet,
          },
        }),
      });

      if (response.ok) {
        const result = await response.json();
        const physicalDesc = result.value;
        setPhysicalAppearance(physicalDesc);

        // Now generate photo with the new physical description
        await handleGeneratePhotoWithAppearance(physicalDesc);
      } else {
        throw new Error("Failed to generate physical description");
      }
    } catch (error) {
      console.error("Error generating physical description:", error);
      alert("Failed to generate physical description. Please try again.");
      setGeneratingPhoto(false);
    }
    // Don't set generatingPhoto to false here - handleGeneratePhotoWithAppearance will do it
  };

  const handleRandomName = () => {
    setFormData({ ...formData, name: getRandomName() });
  };

  const handleGenerateField = async (fieldName: keyof CharacterFormData) => {
    setGeneratingField(fieldName);
    try {
      const response = await fetch("/api/generate-field", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fieldName,
          currentValue: formData[fieldName],
          context: {
            name: formData.name,
            gender: gender,
            description: formData.description,
            howYouMet: formData.howYouMet,
            sayHello: formData.sayHello,
            sayGoodbye: formData.sayGoodbye,
            sayHowAreYou: formData.sayHowAreYou,
            sayGood: formData.sayGood,
            sayBad: formData.sayBad,
          },
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate field");
      }

      const result = await response.json();
      setFormData({ ...formData, [fieldName]: result.value });
    } catch (error) {
      console.error("Error generating field:", error);
      alert("Failed to generate. Please try again.");
    } finally {
      setGeneratingField(null);
    }
  };

  // Handle auto-generation flow when user triggers photo generation
  // biome-ignore lint/correctness/useExhaustiveDependencies: Multi-step auto-gen; full deps would re-enter while generatingField/generatingPhoto flip.
  useEffect(() => {
    if (!shouldAutoGeneratePhoto) return;

    const autoGenerate = async () => {
      // Step 1: If no description, generate it first
      if (!formData.description.trim()) {
        if (formData.name || formData.howYouMet) {
          await handleGenerateField("description");
          // After description is generated, this effect will run again
        } else {
          alert("Please enter a name or how you met first!");
          setShouldAutoGeneratePhoto(false);
        }
        return;
      }

      // Step 2: We have description, now generate physical description and photo
      if (!generatingField && !generatingPhoto) {
        try {
          setGeneratingPhoto(true);

          // Generate physical description from character description
          const response = await fetch("/api/generate-field", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              fieldName: "physicalAppearance",
              currentValue: "",
              context: {
                name: formData.name,
                gender: gender,
                description: formData.description,
                howYouMet: formData.howYouMet,
              },
            }),
          });

          if (response.ok) {
            const result = await response.json();
            const physicalDesc = result.value;
            setPhysicalAppearance(physicalDesc);

            // Generate photo with the physical description
            await handleGeneratePhotoWithAppearance(physicalDesc);
          }
        } catch (error) {
          console.error("Error in auto-generation:", error);
        } finally {
          setGeneratingPhoto(false);
          setShouldAutoGeneratePhoto(false);
        }
      }
    };

    autoGenerate();
  }, [shouldAutoGeneratePhoto, formData.description, generatingField, generatingPhoto]);

  const handleGeneratePhotoWithAppearance = async (appearance: string) => {
    if (!appearance.trim()) {
      return;
    }

    setGeneratingPhoto(true);

    try {
      const response = await fetch("/api/generate-photo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appearance,
          name: formData.name || "person",
        }),
      });

      // Check if response is streaming (Fal) or JSON (OpenAI)
      const contentType = response.headers.get("content-type");

      if (contentType?.includes("text/event-stream")) {
        // Handle streaming response from Fal
        console.log("Handling streaming response from Fal");
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
          throw new Error("Stream reader not available");
        }

        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log("Stream completed");
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const jsonStr = line.slice(6).trim();
                if (!jsonStr) continue;

                const data = JSON.parse(jsonStr);
                console.log("Streaming event:", data);

                if (data.type === "progress") {
                  console.log("Progress update:", data.message);
                  // No UI update needed - just let images stream
                } else if (data.type === "image") {
                  // Preload image before swapping to avoid flash
                  const img = new Image();
                  img.onload = () => {
                    console.log("Image preloaded, swapping to:", data.imageUrl);
                    setPhotoPreview(data.imageUrl);
                  };
                  img.onerror = () => {
                    console.error("Failed to preload image:", data.imageUrl);
                  };
                  img.src = data.imageUrl;
                } else if (data.type === "complete") {
                  // Preload final image
                  const img = new Image();
                  img.onload = () => {
                    console.log("Final image loaded:", data.imageUrl);
                    setPhotoPreview(data.imageUrl);
                    setFormData((prev) => ({ ...prev, photoUrl: data.imageUrl }));
                  };
                  img.onerror = () => {
                    console.error("Failed to load final image:", data.imageUrl);
                  };
                  img.src = data.imageUrl;
                } else if (data.type === "error") {
                  throw new Error(data.error || "Generation failed");
                }
              } catch (e) {
                // Only log actual errors, not JSON parsing issues
                if (
                  e instanceof Error &&
                  !e.message.includes("JSON") &&
                  !e.message.includes("Unexpected")
                ) {
                  throw e; // Re-throw actual errors
                }
              }
            }
          }
        }
      } else {
        // Handle JSON response (OpenAI fallback)
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: "Unknown error" }));

          if (response.status === 400 && errorData.error?.includes("not available")) {
            console.log("Image generation not available. Skipping photo generation.");
            setGeneratingPhoto(false);
            setPhotoProgress("");
            return;
          }

          throw new Error(errorData.error || "Failed to generate photo");
        }

        const result = await response.json();
        console.log("Photo generated successfully:", result);

        if (result.imageUrl) {
          setPhotoPreview(result.imageUrl);
          setFormData((prev) => ({ ...prev, photoUrl: result.imageUrl }));
        } else {
          throw new Error("No image URL in response");
        }
      }
    } catch (error) {
      console.error("Error generating photo:", error);
      alert("Failed to generate photo. Please try again or upload a photo instead.");
    } finally {
      setGeneratingPhoto(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // Create FormData for file upload
      const submitData = new FormData();
      submitData.append("name", formData.name);
      submitData.append("description", formData.description);
      submitData.append("howYouMet", formData.howYouMet);

      // Add speech examples
      if (formData.sayHello) submitData.append("sayHello", formData.sayHello);
      if (formData.sayGoodbye) submitData.append("sayGoodbye", formData.sayGoodbye);
      if (formData.sayHowAreYou) submitData.append("sayHowAreYou", formData.sayHowAreYou);
      if (formData.sayGood) submitData.append("sayGood", formData.sayGood);
      if (formData.sayBad) submitData.append("sayBad", formData.sayBad);

      if (formData.photoFile) {
        submitData.append("photo", formData.photoFile);
      } else if (formData.photoUrl) {
        submitData.append("photoUrl", formData.photoUrl);
      }

      if (physicalAppearance) {
        submitData.append("physicalAppearance", physicalAppearance);
      }

      // Add gender
      submitData.append("gender", gender);

      // Submit to API
      const response = await fetch("/api/create-character", {
        method: "POST",
        body: submitData,
      });

      if (!response.ok) {
        throw new Error("Failed to create character");
      }

      const result = await response.json();

      // Enhance character data with current photoUrl before storing
      const characterDataWithPhoto = {
        ...result.data.character,
        photoUrl: formData.photoUrl || photoPreview, // Make sure we include the generated/uploaded photo
      };

      // Store session data and character for Cloud API
      localStorage.setItem("cyc_session_id", result.data.sessionId);
      localStorage.setItem("cyc_character_id", result.data.characterId);
      localStorage.setItem("cyc_character_data", JSON.stringify(characterDataWithPhoto));

      // Keep the form draft so users can go back and create another character

      // Navigate to cloning page (which will redirect to Cloud)
      router.push(ROUTES.cloning);
    } catch (error) {
      console.error("Error creating character:", error);
      alert("Failed to create character. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background Image with slight blur */}
      <div
        className="fixed inset-0 bg-cover bg-center blur-sm"
        style={{ backgroundImage: "url(/bg.jpg)" }}
      />

      {/* Subtle Gradient Overlay for depth */}
      <div className="fixed inset-0 bg-gradient-to-br from-blue-500/10 via-purple-500/10 to-pink-500/10" />

      {/* Content */}
      <div className="relative z-10 min-h-screen flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {/* Hero Section */}
          <div className="text-center mb-8">
            <h1
              className="text-5xl sm:text-6xl font-bold mb-4 gradient-text"
              style={{
                filter:
                  "drop-shadow(0 0 20px rgba(255, 255, 255, 0.9)) drop-shadow(0 0 40px rgba(255, 255, 255, 0.6)) drop-shadow(0 0 60px rgba(255, 255, 255, 0.3))",
              }}
            >
              Clone Your Crush
            </h1>
          </div>

          {/* Character Creation Form - Enhanced Glass Card */}
          <div className="bg-white/70 backdrop-blur-2xl rounded-3xl shadow-2xl p-8 border border-white/60">
            {/* Progress Indicator - Minimal Dots */}
            <div className="flex justify-center gap-2 mb-8">
              {[1, 2, 3, 4, 5].map((step) => (
                <div
                  key={step}
                  className={`h-2 rounded-full transition-all ${
                    step === currentStep
                      ? "w-8 bg-gradient-to-r from-blue-500 to-pink-500"
                      : step < currentStep
                        ? "w-2 bg-purple-400"
                        : "w-2 bg-gray-300"
                  }`}
                />
              ))}
            </div>

            <form onSubmit={handleSubmit} className="space-y-5 sm:space-y-6">
              {/* Step 1: Name & Gender */}
              {currentStep === 1 && (
                <div>
                  <label
                    htmlFor="name"
                    className="block text-sm sm:text-base font-medium text-gray-700 mb-2"
                  >
                    What&apos;s her name? <span className="text-red-500">*</span>
                  </label>

                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type="text"
                        id="name"
                        required
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full px-4 py-3 sm:py-3.5 pr-12 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent transition-all text-gray-900 bg-white text-base"
                        placeholder="e.g., Ashley"
                      />
                      <button
                        type="button"
                        onClick={handleRandomName}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-primary transition-colors touch-manipulation"
                        title="Random name"
                      >
                        <Dices className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 2: Description */}
              {currentStep === 2 && (
                <div>
                  <label
                    htmlFor="description"
                    className="block text-sm sm:text-base font-medium text-gray-700 mb-2 flex items-center justify-between gap-2"
                  >
                    <span>
                      Tell me about her <span className="text-red-500">*</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => handleGenerateField("description")}
                      disabled={generatingField === "description"}
                      className="flex items-center gap-1 text-xs sm:text-sm text-primary hover:text-primary-dark transition-colors disabled:opacity-50 touch-manipulation whitespace-nowrap"
                      title="Generate with AI"
                    >
                      {generatingField === "description" ? (
                        <>
                          <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                          <span className="hidden sm:inline">Generating...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3 h-3" />
                          <span>Generate</span>
                        </>
                      )}
                    </button>
                  </label>
                  <textarea
                    id="description"
                    required
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    rows={4}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent transition-all resize-none text-gray-900 bg-white text-base"
                    placeholder="e.g., She's playful and fun, with a great sense of humor..."
                  />
                </div>
              )}

              {/* Step 3: How You Met */}
              {currentStep === 3 && (
                <div>
                  <label
                    htmlFor="howYouMet"
                    className="block text-sm sm:text-base font-medium text-gray-700 mb-2 flex items-center justify-between gap-2"
                  >
                    <span>
                      How did you two meet? <span className="text-red-500">*</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => handleGenerateField("howYouMet")}
                      disabled={generatingField === "howYouMet"}
                      className="flex items-center gap-1 text-xs sm:text-sm text-primary hover:text-primary-dark transition-colors disabled:opacity-50 touch-manipulation whitespace-nowrap"
                      title="Generate with AI"
                    >
                      {generatingField === "howYouMet" ? (
                        <>
                          <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                          <span className="hidden sm:inline">Generating...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3 h-3" />
                          <span>Generate</span>
                        </>
                      )}
                    </button>
                  </label>
                  <textarea
                    id="howYouMet"
                    required
                    value={formData.howYouMet}
                    onChange={(e) => setFormData({ ...formData, howYouMet: e.target.value })}
                    rows={3}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent transition-all resize-none text-gray-900 bg-white text-base"
                    placeholder="e.g., We met at a coffee shop downtown..."
                  />
                </div>
              )}

              {/* Step 4: Photo */}
              {currentStep === 4 && (
                <div>
                  <label className="block text-sm sm:text-base font-medium text-gray-700 mb-3">
                    Generate her photo
                  </label>

                  {/* Photo Widget Box - Generation Only */}
                  <div className="border-2 border-gray-200 rounded-xl p-4 sm:p-6 bg-gradient-to-br from-gray-50 to-white">
                    <div className="min-h-[200px] flex flex-col items-center justify-center">
                      <div className="w-full flex flex-col items-center">
                        {/* Photo Preview - Seamless Streaming */}
                        <div className="relative mb-4">
                          {photoPreview ? (
                            <>
                              <img
                                key={photoPreview}
                                src={photoPreview}
                                alt="Preview"
                                className="w-48 h-48 rounded-full object-cover shadow-lg transition-opacity duration-300"
                              />
                              {/* Regenerate Button - Bottom Right */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  console.log("Regenerate button clicked");
                                  handleGeneratePhoto();
                                }}
                                disabled={generatingPhoto || generatingField === "description"}
                                className="absolute bottom-2 right-2 w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center hover:bg-gray-50 transition-all border-2 border-gray-200 touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed z-10"
                                title="Regenerate photo"
                              >
                                <RefreshCw className="w-5 h-5 text-accent" />
                              </button>
                            </>
                          ) : generatingPhoto || generatingField === "description" ? (
                            <div className="w-48 h-48 rounded-full bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center shadow-lg">
                              <div className="w-16 h-16 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
                            </div>
                          ) : (
                            <div
                              className="w-48 h-48 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex flex-col items-center justify-center shadow-lg cursor-pointer hover:from-gray-300 hover:to-gray-400 transition-all"
                              onClick={() => {
                                if (formData.description.trim()) {
                                  setShouldAutoGeneratePhoto(true);
                                } else {
                                  alert("Please fill in the description first!");
                                }
                              }}
                            >
                              <Sparkles
                                className="w-20 h-20 text-gray-500 mb-2"
                                strokeWidth={1.5}
                              />
                              <p className="text-sm text-gray-600 px-6 text-center font-medium">
                                Click to generate
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 5: How She Talks */}
              {currentStep === 5 && (
                <div>
                  <label className="block text-sm sm:text-base font-medium text-gray-700 mb-3">
                    How does she talk?
                  </label>
                  <div className="border-2 border-gray-200 rounded-xl p-4 sm:p-6 bg-gradient-to-br from-gray-50 to-white space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <div>
                        <label
                          htmlFor="sayHello"
                          className="block text-xs sm:text-sm font-medium text-gray-600 mb-1 flex items-center justify-between"
                        >
                          <span>How she says &quot;hello&quot;</span>
                          <button
                            type="button"
                            onClick={() => handleGenerateField("sayHello")}
                            disabled={generatingField === "sayHello"}
                            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark transition-colors disabled:opacity-50 touch-manipulation"
                          >
                            {generatingField === "sayHello" ? (
                              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Sparkles className="w-3 h-3" />
                            )}
                          </button>
                        </label>
                        <input
                          type="text"
                          id="sayHello"
                          value={formData.sayHello}
                          onChange={(e) => setFormData({ ...formData, sayHello: e.target.value })}
                          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent transition-all text-gray-900 bg-white text-sm sm:text-base"
                          placeholder="e.g., &quot;Hey babe!&quot;"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="sayGoodbye"
                          className="block text-xs sm:text-sm font-medium text-gray-600 mb-1 flex items-center justify-between"
                        >
                          <span>How she says &quot;goodbye&quot;</span>
                          <button
                            type="button"
                            onClick={() => handleGenerateField("sayGoodbye")}
                            disabled={generatingField === "sayGoodbye"}
                            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark transition-colors disabled:opacity-50 touch-manipulation"
                          >
                            {generatingField === "sayGoodbye" ? (
                              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Sparkles className="w-3 h-3" />
                            )}
                          </button>
                        </label>
                        <input
                          type="text"
                          id="sayGoodbye"
                          value={formData.sayGoodbye}
                          onChange={(e) => setFormData({ ...formData, sayGoodbye: e.target.value })}
                          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent transition-all text-gray-900 bg-white text-sm sm:text-base"
                          placeholder="e.g., &quot;Talk soon babe!&quot;"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="sayHowAreYou"
                          className="block text-xs sm:text-sm font-medium text-gray-600 mb-1 flex items-center justify-between"
                        >
                          <span>How she asks &quot;how are you?&quot;</span>
                          <button
                            type="button"
                            onClick={() => handleGenerateField("sayHowAreYou")}
                            disabled={generatingField === "sayHowAreYou"}
                            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark transition-colors disabled:opacity-50 touch-manipulation"
                          >
                            {generatingField === "sayHowAreYou" ? (
                              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Sparkles className="w-3 h-3" />
                            )}
                          </button>
                        </label>
                        <input
                          type="text"
                          id="sayHowAreYou"
                          value={formData.sayHowAreYou}
                          onChange={(e) =>
                            setFormData({ ...formData, sayHowAreYou: e.target.value })
                          }
                          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent transition-all text-gray-900 bg-white text-sm sm:text-base"
                          placeholder="e.g., &quot;How was your day?&quot;"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="sayGood"
                          className="block text-xs sm:text-sm font-medium text-gray-600 mb-1 flex items-center justify-between"
                        >
                          <span>What she says when things are good</span>
                          <button
                            type="button"
                            onClick={() => handleGenerateField("sayGood")}
                            disabled={generatingField === "sayGood"}
                            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark transition-colors disabled:opacity-50 touch-manipulation"
                          >
                            {generatingField === "sayGood" ? (
                              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Sparkles className="w-3 h-3" />
                            )}
                          </button>
                        </label>
                        <input
                          type="text"
                          id="sayGood"
                          value={formData.sayGood}
                          onChange={(e) => setFormData({ ...formData, sayGood: e.target.value })}
                          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent transition-all text-gray-900 bg-white text-sm sm:text-base"
                          placeholder="e.g., &quot;That's awesome!&quot;"
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <label
                          htmlFor="sayBad"
                          className="block text-xs sm:text-sm font-medium text-gray-600 mb-1 flex items-center justify-between"
                        >
                          <span>What she says when things are bad</span>
                          <button
                            type="button"
                            onClick={() => handleGenerateField("sayBad")}
                            disabled={generatingField === "sayBad"}
                            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark transition-colors disabled:opacity-50 touch-manipulation"
                          >
                            {generatingField === "sayBad" ? (
                              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Sparkles className="w-3 h-3" />
                            )}
                          </button>
                        </label>
                        <input
                          type="text"
                          id="sayBad"
                          value={formData.sayBad}
                          onChange={(e) => setFormData({ ...formData, sayBad: e.target.value })}
                          className="w-full px-3 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent transition-all text-gray-900 bg-white text-sm sm:text-base"
                          placeholder="e.g., &quot;Aw babe... I&apos;m here for you&quot;"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Navigation Buttons */}
              <div className="flex gap-3 pt-4">
                {currentStep > 1 && (
                  <button
                    type="button"
                    onClick={() => setCurrentStep((prev) => prev - 1)}
                    className="flex-1 bg-white/60 backdrop-blur-sm hover:bg-white/80 text-gray-700 font-bold py-4 px-6 rounded-2xl transition-all border border-white/50"
                  >
                    ← Back
                  </button>
                )}

                {currentStep < totalSteps ? (
                  <button
                    type="button"
                    onClick={() => setCurrentStep((prev) => prev + 1)}
                    className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold py-4 px-6 rounded-2xl transition-all shadow-lg hover:shadow-xl"
                  >
                    Next →
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold py-4 px-6 rounded-2xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg hover:shadow-xl"
                  >
                    {isLoading ? (
                      <>
                        <div className="w-5 h-5 border-3 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Creating...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-5 h-5" />
                        <span>Create</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
