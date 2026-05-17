/**
 * API Endpoint Discovery System
 *
 * Catalogs available API endpoints from the Eliza Cloud API
 * for automatic documentation and testing in API Explorer.
 */

/**
 * Valid parameter value types for API endpoints.
 * Matches the type field options in EndpointParameter.
 * Uses JsonValue for recursive JSON-compatible types.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Pricing information for an API endpoint.
 */
export interface EndpointPricing {
  cost: number; // Cost in USD per request
  unit: "request" | "image" | "video" | "minute" | "1k tokens" | "1k chars" | "clone";
  description?: string;
  isFree?: boolean;
  isVariable?: boolean; // True if cost varies based on usage
  estimatedRange?: { min: number; max: number }; // For variable pricing
}

export function formatEndpointPrice(pricing: ApiEndpoint["pricing"]): string | null {
  if (!pricing) return null;
  if (pricing.isFree) return "Free";
  if (pricing.isVariable && pricing.estimatedRange) {
    return `$${pricing.estimatedRange.min.toFixed(3)} - $${pricing.estimatedRange.max.toFixed(2)}`;
  }

  if (typeof pricing.cost !== "number" || !Number.isFinite(pricing.cost)) {
    return pricing.description ?? "Variable";
  }

  return `$${pricing.cost.toFixed(pricing.cost < 0.01 ? 4 : 2)}`;
}

/**
 * Parameter definition for an API endpoint.
 */
export interface EndpointParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description: string;
  example?: JsonValue;
  enum?: string[];
  format?: string;
  defaultValue?: JsonValue;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * Response definition for an API endpoint.
 */
export interface EndpointResponse {
  statusCode: number;
  description: string;
  schema?: Record<string, JsonValue>;
  example?: Record<string, JsonValue>;
}

/**
 * Complete API endpoint definition.
 */
export interface ApiEndpoint {
  id: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  category: string;
  name: string;
  description: string;
  requiresAuth: boolean;
  pricing?: EndpointPricing;
  parameters?: {
    path?: EndpointParameter[];
    query?: EndpointParameter[];
    body?: EndpointParameter[];
    headers?: EndpointParameter[];
  };
  responses: EndpointResponse[];
  tags: string[];
  deprecated?: boolean;
  rateLimit?: {
    requests: number;
    window: string;
  };
}

/**
 * Complete catalog of Eliza Cloud API endpoints
 */
export const API_ENDPOINTS: ApiEndpoint[] = [
  // Image Generation
  {
    id: "generate-image",
    path: "/api/v1/generate-image",
    method: "POST",
    category: "Image Generation",
    name: "Generate Image",
    description: "Generate images from text prompts using AI models (supports API key auth)",
    requiresAuth: true,
    pricing: {
      cost: 0.01,
      unit: "image",
      description: "Per image generated",
    },
    parameters: {
      body: [
        {
          name: "prompt",
          type: "string",
          required: true,
          description: "Text description of the desired image",
          defaultValue: "A beautiful mountain landscape at sunset",
          example: "A futuristic city with flying cars and neon lights",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Image generated successfully",
      },
      {
        statusCode: 400,
        description: "Invalid request parameters",
      },
      {
        statusCode: 401,
        description: "Authentication required",
      },
    ],
    tags: ["ai-generation", "images"],
  },

  // Video Generation
  {
    id: "generate-video",
    path: "/api/v1/generate-video",
    method: "POST",
    category: "Video Generation",
    name: "Generate Video",
    description: "Generate videos from text prompts (supports API key auth)",
    requiresAuth: true,
    pricing: {
      cost: 0.05,
      unit: "video",
      description: "Per video generated",
    },
    parameters: {
      body: [
        {
          name: "prompt",
          type: "string",
          required: true,
          description: "Text description of the desired video",
          defaultValue: "A serene mountain landscape with clouds moving slowly",
          example: "A futuristic city with flying cars at night",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Video generated successfully",
      },
      {
        statusCode: 400,
        description: "Invalid request parameters",
      },
    ],
    tags: ["ai-generation", "videos"],
  },

  // Chat Completions
  {
    id: "chat-completions",
    path: "/api/v1/chat",
    method: "POST",
    category: "AI Completions",
    name: "Chat Completion",
    description: "Generate text completions using AI SDK format (supports API key auth)",
    requiresAuth: true,
    pricing: {
      cost: 0.0025,
      unit: "1k tokens",
      description: "Input tokens (output varies by model)",
      isVariable: true,
      estimatedRange: { min: 0.001, max: 0.03 },
    },
    parameters: {
      body: [
        {
          name: "messages",
          type: "array",
          required: true,
          description: "Array of UIMessage objects (AI SDK format with role and parts)",
          defaultValue: '[{"role":"user","parts":[{"type":"text","text":"Hello, how are you?"}]}]',
          example: '[{"role":"user","parts":[{"type":"text","text":"Explain quantum computing"}]}]',
        },
        {
          name: "id",
          type: "string",
          required: false,
          description: "Model to use for completion",
          defaultValue: "gpt-4o",
          example: "gpt-5-mini",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Text generated successfully",
      },
    ],
    tags: ["ai-generation", "text"],
  },

  // Generate Prompts
  {
    id: "generate-prompts",
    path: "/api/v1/generate-prompts",
    method: "POST",
    category: "AI Completions",
    name: "Generate Prompts",
    description: "Generate creative prompts for image/video generation (session auth only)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      body: [
        {
          name: "seed",
          type: "number",
          required: false,
          description: "Seed for prompt generation (optional, auto-generated if not provided)",
          example: 1234567890,
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Prompts generated successfully",
      },
    ],
    tags: ["ai-generation", "prompts"],
  },

  // Models
  {
    id: "models-list",
    path: "/api/v1/models",
    method: "GET",
    category: "Models",
    name: "List Models",
    description: "List all available AI models (supports API key auth)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {},
    responses: [
      {
        statusCode: 200,
        description: "Models retrieved successfully",
      },
    ],
    tags: ["models"],
  },

  // Gallery
  {
    id: "gallery-list",
    path: "/api/v1/gallery",
    method: "GET",
    category: "Gallery",
    name: "List Generations",
    description: "List all media generations (images and videos) (supports API key auth)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      query: [
        {
          name: "type",
          type: "string",
          required: false,
          description: "Filter by media type",
          enum: ["image", "video"],
          example: "image",
        },
        {
          name: "limit",
          type: "number",
          required: false,
          description: "Maximum number of results",
          defaultValue: 100,
          example: 50,
        },
        {
          name: "offset",
          type: "number",
          required: false,
          description: "Pagination offset",
          defaultValue: 0,
          example: 0,
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Generations retrieved successfully",
      },
    ],
    tags: ["gallery", "media"],
  },

  // User Profile - Get
  {
    id: "user-get",
    path: "/api/v1/user",
    method: "GET",
    category: "User Management",
    name: "Get User Profile",
    description:
      "Get current user profile and organization details (session auth only - won't work with API key)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {},
    responses: [
      {
        statusCode: 200,
        description: "User profile retrieved successfully",
      },
    ],
    tags: ["user"],
  },

  // User Profile - Update
  {
    id: "user-update",
    path: "/api/v1/user",
    method: "PATCH",
    category: "User Management",
    name: "Update User Profile",
    description: "Update user profile information (session auth only - won't work with API key)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      body: [
        {
          name: "name",
          type: "string",
          required: false,
          description: "User's display name",
          example: "John Doe",
        },
        {
          name: "avatar",
          type: "string",
          required: false,
          description: "Avatar URL",
          example: "https://example.com/avatar.jpg",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Profile updated successfully",
      },
    ],
    tags: ["user"],
  },

  // API Keys - List
  {
    id: "api-keys-list",
    path: "/api/v1/api-keys",
    method: "GET",
    category: "API Keys",
    name: "List API Keys",
    description:
      "List all API keys for your organization (session auth only - won't work with API key)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {},
    responses: [
      {
        statusCode: 200,
        description: "API keys retrieved successfully",
      },
    ],
    tags: ["api-keys"],
  },

  // API Keys - Create
  {
    id: "api-keys-create",
    path: "/api/v1/api-keys",
    method: "POST",
    category: "API Keys",
    name: "Create API Key",
    description: "Create a new API key (session auth only - won't work with API key)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      body: [
        {
          name: "name",
          type: "string",
          required: true,
          description: "Name for the API key",
          defaultValue: "Test Key",
          example: "Production API Key",
        },
        {
          name: "description",
          type: "string",
          required: false,
          description: "Optional description",
          example: "Used for production services",
        },
        {
          name: "permissions",
          type: "array",
          required: false,
          description: "Array of permissions",
          defaultValue: "[]",
          example: '["read", "write"]',
        },
        {
          name: "rate_limit",
          type: "number",
          required: false,
          description: "Rate limit per minute",
          defaultValue: 1000,
          example: 1000,
        },
      ],
    },
    responses: [
      {
        statusCode: 201,
        description: "API key created successfully",
      },
    ],
    tags: ["api-keys"],
  },

  // API Keys - Delete
  {
    id: "api-keys-delete",
    path: "/api/v1/api-keys/{id}",
    method: "DELETE",
    category: "API Keys",
    name: "Delete API Key",
    description: "Delete an API key (session auth only - won't work with API key)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      path: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "API key ID",
          example: "key_123abc",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "API key deleted successfully",
      },
    ],
    tags: ["api-keys"],
  },

  // API Keys - Update
  {
    id: "api-keys-update",
    path: "/api/v1/api-keys/{id}",
    method: "PATCH",
    category: "API Keys",
    name: "Update API Key",
    description: "Update API key properties (session auth only - won't work with API key)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      path: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "API key ID",
          example: "key_123abc",
        },
      ],
      body: [
        {
          name: "name",
          type: "string",
          required: false,
          description: "New name for the API key",
          example: "Updated Key Name",
        },
        {
          name: "is_active",
          type: "boolean",
          required: false,
          description: "Enable or disable the key",
          example: true,
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "API key updated successfully",
      },
    ],
    tags: ["api-keys"],
  },

  // API Keys - Regenerate
  {
    id: "api-keys-regenerate",
    path: "/api/v1/api-keys/{id}/regenerate",
    method: "POST",
    category: "API Keys",
    name: "Regenerate API Key",
    description:
      "Regenerate API key secret (old key becomes invalid) (session auth only - won't work with API key)",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      path: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "API key ID",
          example: "key_123abc",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "API key regenerated successfully",
      },
    ],
    tags: ["api-keys"],
  },

  // Voice Generation - Text-to-Speech
  {
    id: "voice-text-to-speech",
    path: "/api/elevenlabs/tts",
    method: "POST",
    category: "Voice Generation",
    name: "Text-to-Speech",
    description:
      "Convert text to realistic speech audio using ElevenLabs. Supports custom cloned voices and multiple voice models. Returns streaming audio response.",
    requiresAuth: true,
    pricing: {
      cost: 0.003,
      unit: "1k tokens",
      description: "Per 1K characters (~150 words)",
      isVariable: true,
      estimatedRange: { min: 0.001, max: 0.01 },
    },
    parameters: {
      body: [
        {
          name: "text",
          type: "string",
          required: true,
          description: "Text to convert to speech (max 5000 characters)",
          defaultValue: "Hello! This is a sample text-to-speech conversion.",
          example:
            "Welcome to Eliza Cloud. Our voice generation API provides high-quality, natural-sounding speech synthesis.",
        },
        {
          name: "voiceId",
          type: "string",
          required: false,
          description: "ElevenLabs voice ID (use your custom cloned voice ID or default voice)",
          example: "21m00Tcm4TlvDq8ikWAM",
        },
        {
          name: "modelId",
          type: "string",
          required: false,
          description: "Voice model to use",
          defaultValue: "eleven_flash_v2_5",
          enum: [
            "eleven_flash_v2_5",
            "eleven_turbo_v2_5",
            "eleven_multilingual_v2",
            "eleven_monolingual_v1",
          ],
          example: "eleven_flash_v2_5",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Audio stream generated successfully (Content-Type: audio/mpeg)",
      },
      {
        statusCode: 400,
        description: "Invalid request (missing text, text too long, etc.)",
      },
      {
        statusCode: 429,
        description: "Rate limit exceeded",
      },
    ],
    tags: ["voice", "tts", "audio-generation"],
    rateLimit: {
      requests: 100,
      window: "minute",
    },
  },

  // Voice Generation - Speech-to-Text
  {
    id: "voice-speech-to-text",
    path: "/api/elevenlabs/stt",
    method: "POST",
    category: "Voice Generation",
    name: "Speech-to-Text",
    description:
      "Transcribe audio to text using ElevenLabs. Supports multiple audio formats including MP3, WAV, M4A, WebM, and OGG. Max file size: 25MB. The API Explorer provides a built-in voice recorder for easy testing.",
    requiresAuth: true,
    pricing: {
      cost: 0.01,
      unit: "minute",
      description: "Per minute of audio transcribed",
      isVariable: true,
    },
    parameters: {
      body: [
        {
          name: "audio",
          type: "string",
          required: true,
          description:
            "Audio file (multipart/form-data). Use the built-in recorder in API Explorer or upload via cURL. Supported formats: mp3, wav, m4a, webm, ogg. Max 25MB.",
          format: "binary",
          example: "Record using the microphone button in API Explorer",
        },
        {
          name: "languageCode",
          type: "string",
          required: false,
          description: "ISO 639-1 language code for transcription (auto-detect if not provided)",
          example: "en",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Audio transcribed successfully",
        example: {
          transcript: "This is the transcribed text from the audio file.",
          duration_ms: 1234,
        },
      },
      {
        statusCode: 400,
        description: "Invalid audio file or format",
      },
      {
        statusCode: 402,
        description: "Paid ElevenLabs plan required",
      },
      {
        statusCode: 429,
        description: "Rate limit exceeded",
      },
    ],
    tags: ["voice", "stt", "transcription"],
    rateLimit: {
      requests: 50,
      window: "minute",
    },
  },

  // Voice Generation - List Available Voices
  {
    id: "voice-list-available",
    path: "/api/elevenlabs/voices",
    method: "GET",
    category: "Voice Generation",
    name: "List Available Voices",
    description:
      "Get all available ElevenLabs pre-built public voices (Rachel, Adam, etc.). This endpoint only returns premade voices that all users can use. Custom cloned voices are NOT included here - use 'List User Cloned Voices' endpoint to see your personal voices.",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {},
    responses: [
      {
        statusCode: 200,
        description: "Public voices retrieved successfully",
        example: {
          voices: [
            {
              voice_id: "21m00Tcm4TlvDq8ikWAM",
              name: "Rachel",
              category: "premade",
              description: "Young American female voice",
            },
            {
              voice_id: "pNInz6obpgDQGcFmaJgB",
              name: "Adam",
              category: "premade",
              description: "Deep American male voice",
            },
          ],
        },
      },
      {
        statusCode: 500,
        description: "Service not configured or unavailable",
      },
    ],
    tags: ["voice", "voices"],
  },

  // Voice Cloning - Clone Voice
  {
    id: "voice-clone-create",
    path: "/api/elevenlabs/voices/clone",
    method: "POST",
    category: "Voice Cloning",
    name: "Clone Voice",
    description:
      "Create a custom voice clone using audio samples. Supports instant cloning (30s, 50 credits) and professional cloning (1-3hrs, 200 credits). Upload 1-10 audio files (max 100MB total). The API Explorer provides a built-in file uploader for easy testing.",
    requiresAuth: true,
    pricing: {
      cost: 0.5,
      unit: "clone",
      description: "Instant: 50 credits, Professional: 200 credits",
      isVariable: true,
      estimatedRange: { min: 0.5, max: 2.0 },
    },
    parameters: {
      body: [
        {
          name: "name",
          type: "string",
          required: true,
          description: "Name for the cloned voice",
          example: "My Custom Voice",
        },
        {
          name: "description",
          type: "string",
          required: false,
          description: "Optional description of the voice",
          example: "Professional narrator voice for audiobooks",
        },
        {
          name: "cloneType",
          type: "string",
          required: true,
          description:
            "Cloning type: instant (50 credits, 30s) or professional (200 credits, 30-60min)",
          enum: ["instant", "professional"],
          example: "instant",
        },
        {
          name: "file0",
          type: "string",
          required: true,
          description:
            "Audio sample file (multipart/form-data). At least 1 required, max 10 files. Use the file uploader in API Explorer to upload audio samples.",
          format: "binary",
          example: "Upload audio file using the file uploader above",
        },
        {
          name: "file1",
          type: "string",
          required: false,
          description: "Additional audio sample (optional, multipart/form-data)",
          format: "binary",
          example: "sample2.mp3",
        },
        {
          name: "settings",
          type: "string",
          required: false,
          description: "JSON string of voice settings (optional)",
          example: '{"stability": 0.5, "similarity_boost": 0.75}',
        },
      ],
    },
    responses: [
      {
        statusCode: 201,
        description: "Voice clone created successfully",
        example: {
          success: true,
          voice: {
            id: "voice_abc123",
            elevenlabsVoiceId: "elab_xyz789",
            name: "My Custom Voice",
            cloneType: "instant",
            status: "processing",
            sampleCount: 3,
          },
          job: {
            id: "job_123",
            status: "processing",
            progress: 0,
          },
          creditsDeducted: 50,
          newBalance: 950,
          estimatedCompletionTime: "30 seconds",
        },
      },
      {
        statusCode: 400,
        description: "Invalid request (missing fields, too many files, file too large)",
      },
      {
        statusCode: 402,
        description: "Insufficient credits",
      },
      {
        statusCode: 429,
        description: "Rate limit exceeded",
      },
    ],
    tags: ["voice", "cloning", "voice-clone"],
    rateLimit: {
      requests: 10,
      window: "hour",
    },
  },

  // Voice Cloning - List User Voices
  {
    id: "voice-list-user",
    path: "/api/elevenlabs/voices/user",
    method: "GET",
    category: "Voice Cloning",
    name: "List User Cloned Voices",
    description:
      "Get all custom voices cloned by your organization. Includes usage statistics, quality scores, and status information. Supports filtering and pagination.",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      query: [
        {
          name: "includeInactive",
          type: "boolean",
          required: false,
          description: "Include inactive/disabled voices",
          defaultValue: false,
          example: false,
        },
        {
          name: "cloneType",
          type: "string",
          required: false,
          description: "Filter by clone type",
          enum: ["instant", "professional"],
          example: "instant",
        },
        {
          name: "limit",
          type: "number",
          required: false,
          description: "Maximum number of results",
          defaultValue: 50,
          example: 20,
          min: 1,
          max: 100,
        },
        {
          name: "offset",
          type: "number",
          required: false,
          description: "Pagination offset",
          defaultValue: 0,
          example: 0,
          min: 0,
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "User voices retrieved successfully",
        example: {
          success: true,
          voices: [
            {
              id: "voice_abc123",
              elevenlabsVoiceId: "elab_xyz789",
              name: "My Custom Voice",
              cloneType: "instant",
              usageCount: 42,
              lastUsedAt: "2025-10-27T10:30:00Z",
              isActive: true,
            },
          ],
          total: 5,
          limit: 50,
          offset: 0,
          hasMore: false,
        },
      },
      {
        statusCode: 401,
        description: "Unauthorized",
      },
    ],
    tags: ["voice", "cloning", "user-voices"],
  },

  // Voice Cloning - Get Voice by ID
  {
    id: "voice-get-by-id",
    path: "/api/elevenlabs/voices/{id}",
    method: "GET",
    category: "Voice Cloning",
    name: "Get Voice Details",
    description:
      "Retrieve detailed information about a specific cloned voice including usage statistics, quality metrics, and configuration settings. Note: Use your internal voice ID (starts with 'voice_'), not the ElevenLabs voice ID.",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      path: [
        {
          name: "id",
          type: "string",
          required: true,
          description:
            "Voice ID (internal UUID, NOT ElevenLabs voice ID). Get this from 'List User Voices' endpoint.",
          example: "voice_abc123-...",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Voice details retrieved successfully",
        example: {
          success: true,
          voice: {
            id: "voice_abc123-uuid-here",
            elevenlabsVoiceId: "elab_xyz789",
            name: "My Custom Voice",
            description: "Professional narrator voice",
            cloneType: "instant",
            sampleCount: 3,
            usageCount: 42,
            audioQualityScore: 0.95,
            isActive: true,
            createdAt: "2025-10-20T10:00:00Z",
          },
        },
      },
      {
        statusCode: 404,
        description: "Voice not found",
      },
      {
        statusCode: 500,
        description: "Invalid voice ID format (must be UUID)",
      },
    ],
    tags: ["voice", "cloning"],
  },

  // Voice Cloning - Delete Voice
  {
    id: "voice-delete",
    path: "/api/elevenlabs/voices/{id}",
    method: "DELETE",
    category: "Voice Cloning",
    name: "Delete Voice",
    description:
      "Permanently delete a cloned voice. This action cannot be undone. The voice will be removed from both Eliza Cloud and ElevenLabs.",
    requiresAuth: true,
    pricing: {
      cost: 0,
      unit: "request",
      isFree: true,
    },
    parameters: {
      path: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Voice ID to delete",
          example: "voice_abc123",
        },
      ],
    },
    responses: [
      {
        statusCode: 200,
        description: "Voice deleted successfully",
        example: {
          success: true,
          message: "Voice deleted successfully",
        },
      },
      {
        statusCode: 404,
        description: "Voice not found",
      },
    ],
    tags: ["voice", "cloning"],
  },
];

/**
 * Get endpoints by category
 */
export function getEndpointsByCategory(category: string): ApiEndpoint[] {
  return API_ENDPOINTS.filter((endpoint) => endpoint.category === category);
}

/**
 * Get all available categories
 */
export function getAvailableCategories(): string[] {
  const categories = API_ENDPOINTS.map((endpoint) => endpoint.category);
  return [...new Set(categories)].sort();
}

/**
 * Search endpoints by name, description, or path
 */
export function searchEndpoints(query: string): ApiEndpoint[] {
  const searchTerm = query.toLowerCase();
  return API_ENDPOINTS.filter(
    (endpoint) =>
      endpoint.name.toLowerCase().includes(searchTerm) ||
      endpoint.description.toLowerCase().includes(searchTerm) ||
      endpoint.path.toLowerCase().includes(searchTerm),
  );
}
