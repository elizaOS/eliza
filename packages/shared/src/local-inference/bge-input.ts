/** Selects a token-verified source suffix for the shared BGE embedding space.
 * Only encoder input is shortened; callers retain the complete stored source.
 * Keeping whole source words avoids converting a leading WordPiece continuation
 * into a different token when Cloudflare retokenizes its string input.
 */
import { ElizaError } from "@elizaos/core";
import { Tokenizer } from "@huggingface/tokenizers";
import tokenizerJson from "./bge/tokenizer.json";
import tokenizerConfig from "./bge/tokenizer_config.json";

const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

export interface BgeEmbeddingInput {
  text: string;
  tokenIds: number[];
  originalTokenCount: number;
}

function sameTail(original: number[], retained: number[]): boolean {
  return (
    retained.length > 2 &&
    retained[0] === 101 &&
    retained.at(-1) === 102 &&
    retained
      .slice(1)
      .every(
        (id, index) =>
          id === original[original.length - retained.length + index + 1],
      )
  );
}

/** Leaves fitting inputs byte-identical; otherwise retains the latest complete words. */
export function prepareBgeEmbeddingInput(
  text: string,
  contextLimit = 512,
): BgeEmbeddingInput {
  if (
    !Number.isInteger(contextLimit) ||
    contextLimit < 3 ||
    contextLimit > 512
  ) {
    throw new ElizaError(
      "BGE requires room for CLS, SEP and content within 512 tokens",
      {
        code: "EMBEDDING_CONTEXT_INVALID",
        context: { contextLimit },
      },
    );
  }
  if (!text.isWellFormed()) {
    throw new ElizaError(
      "Embedding input contains unpaired UTF-16 surrogates",
      {
        code: "EMBEDDING_INPUT_INVALID",
      },
    );
  }
  const original = tokenizer.encode(text).ids;
  if (original.length <= contextLimit) {
    return { text, tokenIds: original, originalTokenCount: original.length };
  }

  // These are candidate source boundaries, not a replacement tokenizer. BERT
  // separates punctuation and Chinese characters; the real tokenizer below
  // proves every selected suffix against the original token sequence.
  const pieces = Array.from(
    text.matchAll(
      /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]|[^\s\p{P}\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]+|[\p{P}\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/gu,
    ),
  );
  let start = pieces.length;
  let estimated = 2;
  const pieceCounts = new Map<string, number>();
  while (start > 0) {
    const piece = pieces[start - 1][0];
    let count = pieceCounts.get(piece);
    if (count === undefined) {
      count = tokenizer.encode(piece, { add_special_tokens: false }).ids.length;
      pieceCounts.set(piece, count);
    }
    if (estimated + count > contextLimit) break;
    estimated += count;
    start--;
  }
  let selected: BgeEmbeddingInput | undefined;
  for (let index = start; index < pieces.length; index++) {
    const suffix = text.slice(pieces[index].index);
    const ids = tokenizer.encode(suffix).ids;
    if (ids.length <= contextLimit && sameTail(original, ids)) {
      selected = {
        text: suffix,
        tokenIds: ids,
        originalTokenCount: original.length,
      };
      start = index;
      break;
    }
  }
  if (!selected) {
    throw new ElizaError(
      "BGE cannot represent the input tail as an unchanged source suffix",
      {
        code: "EMBEDDING_INPUT_UNREPRESENTABLE",
        context: { contextLimit },
      },
    );
  }
  // Added-token spellings can cross candidate punctuation boundaries. Recover
  // any adjacent complete source piece that still fits the actual token budget.
  for (let index = start - 1; index >= 0; index--) {
    const suffix = text.slice(pieces[index].index);
    const ids = tokenizer.encode(suffix).ids;
    if (sameTail(original, ids)) {
      if (ids.length > contextLimit) break;
      selected = {
        text: suffix,
        tokenIds: ids,
        originalTokenCount: original.length,
      };
    }
  }
  return selected;
}

/** Refuses a native tokenizer disagreement before producing a canonical vector. */
export function assertBgeTokenAgreement(
  input: BgeEmbeddingInput,
  actual: ArrayLike<number>,
): void {
  if (
    actual.length !== input.tokenIds.length ||
    input.tokenIds.some((id, index) => id !== actual[index])
  ) {
    throw new ElizaError(
      "Native BGE tokenizer disagrees with the shared embedding input",
      {
        code: "EMBEDDING_TOKENIZER_MISMATCH",
        context: {
          expectedCount: input.tokenIds.length,
          actualCount: actual.length,
        },
      },
    );
  }
}
