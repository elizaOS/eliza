import { brainFor } from "./brain.ts";
import { netTimeoutMs, redactSecrets, withTimeout } from "./net.ts";
import { answerTools } from "./offers.ts";

export interface ChatHost {
  dataDir: string;
  log(kind: string, message: string): void;
  statusLine(): string;
  pnlLine(): string;
  positionsLine(): string;
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
  const brain = brainFor(engine.dataDir);
  if (!brain.ready()) {
    return "I can report status, positions, and P&L. Add a provider key in Controls, or set TOGETHER_API_KEY in .env, for open chat. I still will not send funds.";
  }
  try {
    const reply = await withTimeout(
      brain.complete(
        "chat",
        `${engine.statusLine()}\n${engine.positionsLine()}\n${engine.pnlLine()}\n\nUser: ${question}`
      ),
      netTimeoutMs(),
      "Desk chat"
    );
    return redactSecrets(reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : "chat failed";
    engine.log("chat", `Desk chat failed: ${message}`);
    return "The model did not answer in time. Status is still available from the desk.";
  }
}
