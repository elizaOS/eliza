import { generateWithGemini } from "./gemini.ts";
import { netTimeoutMs, redactSecrets, withTimeout } from "./net.ts";
import { answerTools } from "./offers.ts";

export interface ChatHost {
  log(kind: string, message: string): void;
  statusLine(): string;
  pnlLine(): string;
  positionsLine(): string;
  publicEnv(): Record<string, string | undefined>;
}

const REFUSE =
  /\b(send|transfer|withdraw|sweep|airdrop|drain|wire|cash\s?out)\b|\bprivate key\b|\bseed phrase\b|loosen|disable (the )?(rug|safety|stop|filter)|turn off (the )?(rug|safety|stop|filter)|skip (the )?(filter|rug|safety)/i;

export function refusesUnsafe(text: string): boolean {
  return REFUSE.test(text);
}

export async function answerChat(engine: ChatHost, text: string): Promise<string> {
  const question = text.trim();
  if (!question) return "Ask about status, positions, or P&L.";
  if (refusesUnsafe(question)) {
    engine.log("chat", "Refused an unsafe request.");
    return "No. This agent cannot send, transfer, or withdraw SOL or tokens, and it cannot turn safety checks off.";
  }
  const tools = answerTools(question);
  if (tools) return tools;
  const lower = question.toLowerCase();
  if (/status|running|live|mode/.test(lower)) return engine.statusLine();
  if (/p&l|pnl|profit|loss/.test(lower)) return engine.pnlLine();
  if (/position|holding|open/.test(lower)) return engine.positionsLine();
  const key = engine.publicEnv().GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!key) {
    return "I can report status, positions, and P&L. Add GOOGLE_GENERATIVE_AI_API_KEY in .env for open chat. I still will not send funds.";
  }
  try {
    const reply = await withTimeout(
      generateWithGemini({
        apiKey: key,
        model: engine.publicEnv().VALHALLA_GEMINI_MODEL || "gemini-2.5-flash",
        system:
          "You are Valhalla, the Mech desk agent. Answer in short sentences. You cannot send, transfer, or withdraw funds. You cannot disable rug checks, manipulation checks, or stops. Use only the status below. Addresses are already shortened.",
        prompt: `${engine.statusLine()}\n${engine.positionsLine()}\n${engine.pnlLine()}\n\nUser: ${question}`,
      }),
      netTimeoutMs(),
      "Gemini chat"
    );
    return redactSecrets(reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : "chat failed";
    engine.log("chat", `Gemini chat failed: ${message}`);
    return "The model did not answer in time. Status is still available from the desk.";
  }
}
