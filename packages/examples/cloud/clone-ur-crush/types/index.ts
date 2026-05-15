// ElizaOS Character type matching cloud implementation
export interface ElizaCharacter {
  id?: string;
  name: string;
  username?: string;
  system?: string;
  bio: string | string[];
  messageExamples?: Array<
    Array<{
      name: string;
      content: {
        text: string;
        action?: string;
        [key: string]: unknown;
      };
    }>
  >;
  postExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  knowledge?: (string | { path: string; shared?: boolean })[];
  plugins?: string[];
  settings?: Record<string, string | boolean | number | Record<string, unknown>>;
  secrets?: Record<string, string | boolean | number>;
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
}

// Character creation form data
export interface CharacterFormData {
  name: string;
  description: string;
  photoUrl?: string;
  photoFile?: File;
  howYouMet: string;
  sayHello?: string;
  sayGoodbye?: string;
  sayHowAreYou?: string;
  sayGood?: string;
  sayBad?: string;
}

// Chat session state
export interface ChatSession {
  sessionId: string;
  characterId: string;
  messageCount: number;
  isAuthenticated: boolean;
  conversationId?: string;
}

// Message structure
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface CreateCharacterResponse {
  characterId: string;
  sessionId: string;
  character: ElizaCharacter;
}
