export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  confidence?: number;
  suggestions?: string[];
}
