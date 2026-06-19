export interface NicknameProposal {
  nickname: string;
  subject: "owner" | "household";
  confidence: number;
  supportingTranscriptId: string;
}

export interface NicknameEvaluator {
  evaluate(
    transcript: { id: string; text: string }[],
  ): Promise<NicknameProposal[]>;
}

interface NicknamePattern {
  regex: RegExp;
  subject: "owner" | "household";
  confidence: number;
}

const NAME_TOKEN = "[A-Z][a-zA-Z'\\-]{0,30}";

const PATTERNS: NicknamePattern[] = [
  {
    regex: new RegExp(`\\bcall me (${NAME_TOKEN})\\b`),
    subject: "owner",
    confidence: 0.85,
  },
  {
    regex: new RegExp(`\\bmy name is (${NAME_TOKEN})\\b`),
    subject: "owner",
    confidence: 0.95,
  },
  {
    regex: new RegExp(`\\bI go by (${NAME_TOKEN})\\b`),
    subject: "owner",
    confidence: 0.8,
  },
];

function trimNickname(raw: string): string {
  return raw.replace(/[\s.,!?;:]+$/, "").trim();
}

export const NAIVE_NICKNAME_EVALUATOR: NicknameEvaluator = {
  async evaluate(
    transcript: { id: string; text: string }[],
  ): Promise<NicknameProposal[]> {
    const out: NicknameProposal[] = [];
    for (const entry of transcript) {
      for (const pattern of PATTERNS) {
        const m = pattern.regex.exec(entry.text);
        if (m === null) continue;
        const captured = m[1];
        if (captured === undefined) continue;
        const nickname = trimNickname(captured);
        if (nickname.length === 0) continue;
        out.push({
          nickname,
          subject: pattern.subject,
          confidence: pattern.confidence,
          supportingTranscriptId: entry.id,
        });
      }
    }
    return out;
  },
};
