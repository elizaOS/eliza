export const DEFAULT_CHUNK_TOKEN_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;
export const DEFAULT_CHARS_PER_TOKEN = 3.5;

export const CONTEXT_TARGETS = {
  DEFAULT: {
    MIN_TOKENS: 60,
    MAX_TOKENS: 120,
  },
  PDF: {
    MIN_TOKENS: 80,
    MAX_TOKENS: 150,
  },
  MATH_PDF: {
    MIN_TOKENS: 100,
    MAX_TOKENS: 180,
  },
  CODE: {
    MIN_TOKENS: 100,
    MAX_TOKENS: 200,
  },
  TECHNICAL: {
    MIN_TOKENS: 80,
    MAX_TOKENS: 160,
  },
};

export const SYSTEM_PROMPT =
  "You are a precision text augmentation tool. Your task is to expand a given text chunk with its direct context from a larger document. You must: 1) Keep the original chunk intact; 2) Add critical context from surrounding text; 3) Never summarize or rephrase the original chunk; 4) Create contextually rich output for improved semantic retrieval.";

export const SYSTEM_PROMPTS = {
  DEFAULT:
    "You are a precision text augmentation tool. Your task is to expand a given text chunk with its direct context from a larger document. You must: 1) Keep the original chunk intact; 2) Add critical context from surrounding text; 3) Never summarize or rephrase the original chunk; 4) Create contextually rich output for improved semantic retrieval.",

  CODE: "You are a precision code augmentation tool. Your task is to expand a given code chunk with necessary context from the larger codebase. You must: 1) Keep the original code chunk intact with exact syntax and indentation; 2) Add relevant imports, function signatures, or class definitions; 3) Include critical surrounding code context; 4) Create contextually rich output that maintains correct syntax.",

  PDF: "You are a precision document augmentation tool. Your task is to expand a given PDF text chunk with its direct context from the larger document. You must: 1) Keep the original chunk intact; 2) Add section headings, references, or figure captions; 3) Include text that immediately precedes and follows the chunk; 4) Create contextually rich output that maintains the document's original structure.",

  MATH_PDF:
    "You are a precision mathematical content augmentation tool. Your task is to expand a given mathematical text chunk with essential context. You must: 1) Keep original mathematical notations and expressions exactly as they appear; 2) Add relevant definitions, theorems, or equations from elsewhere in the document; 3) Preserve all LaTeX or mathematical formatting; 4) Create contextually rich output for improved mathematical comprehension.",

  TECHNICAL:
    "You are a precision technical documentation augmentation tool. Your task is to expand a technical document chunk with critical context. You must: 1) Keep the original chunk intact including all technical terminology; 2) Add relevant configuration examples, parameter definitions, or API references; 3) Include any prerequisite information; 4) Create contextually rich output that maintains technical accuracy.",
};

export const CONTEXTUAL_CHUNK_ENRICHMENT_PROMPT_TEMPLATE = `
<document>
{doc_content}
</document>

Here is the chunk we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this chunk by adding critical surrounding context. Follow these guidelines:

1. Identify the document's main topic and key information relevant to understanding this chunk
2. Include 2-3 sentences before the chunk that provide essential context
3. Include 2-3 sentences after the chunk that complete thoughts or provide resolution
4. For technical documents, include any definitions or explanations of terms used in the chunk
5. For narrative content, include character or setting information needed to understand the chunk
6. Keep the original chunk text COMPLETELY INTACT and UNCHANGED in your response
7. Do not use phrases like "this chunk discusses" - directly present the context
8. The total length should be between {min_tokens} and {max_tokens} tokens
9. Format the response as a single coherent paragraph

Provide ONLY the enriched chunk text in your response:`;

export const CACHED_CHUNK_PROMPT_TEMPLATE = `
Here is the chunk we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this chunk by adding critical surrounding context. Follow these guidelines:

1. Identify the document's main topic and key information relevant to understanding this chunk
2. Include 2-3 sentences before the chunk that provide essential context
3. Include 2-3 sentences after the chunk that complete thoughts or provide resolution
4. For technical documents, include any definitions or explanations of terms used in the chunk
5. For narrative content, include character or setting information needed to understand the chunk
6. Keep the original chunk text COMPLETELY INTACT and UNCHANGED in your response
7. Do not use phrases like "this chunk discusses" - directly present the context
8. The total length should be between {min_tokens} and {max_tokens} tokens
9. Format the response as a single coherent paragraph

Provide ONLY the enriched chunk text in your response:`;

export const CACHED_CODE_CHUNK_PROMPT_TEMPLATE = `
Here is the chunk of code we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this code chunk by adding critical surrounding context. Follow these guidelines:

1. Preserve ALL code syntax, indentation, and comments exactly as they appear
2. Include any import statements, function definitions, or class declarations that this code depends on
3. Add necessary type definitions or interfaces that are referenced in this chunk
4. Include any crucial comments from elsewhere in the document that explain this code
5. If there are key variable declarations or initializations earlier in the document, include those
6. Keep the original chunk COMPLETELY INTACT and UNCHANGED in your response
7. The total length should be between {min_tokens} and {max_tokens} tokens
8. Do NOT include implementation details for functions that are only called but not defined in this chunk

Provide ONLY the enriched code chunk in your response:`;

export const CACHED_MATH_PDF_PROMPT_TEMPLATE = `
Here is the chunk we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this chunk by adding critical surrounding context. This document contains mathematical content that requires special handling. Follow these guidelines:

1. Preserve ALL mathematical notation exactly as it appears in the chunk
2. Include any defining equations, variables, or parameters mentioned earlier in the document that relate to this chunk
3. Add section/subsection names or figure references if they help situate the chunk
4. If variables or symbols are defined elsewhere in the document, include these definitions
5. If mathematical expressions appear corrupted, try to infer their meaning from context
6. Keep the original chunk text COMPLETELY INTACT and UNCHANGED in your response
7. The total length should be between {min_tokens} and {max_tokens} tokens
8. Format the response as a coherent mathematical explanation

Provide ONLY the enriched chunk text in your response:`;

export const CACHED_TECHNICAL_PROMPT_TEMPLATE = `
Here is the chunk we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this chunk by adding critical surrounding context. This appears to be technical documentation that requires special handling. Follow these guidelines:

1. Preserve ALL technical terminology, product names, and version numbers exactly as they appear
2. Include any prerequisite information or requirements mentioned earlier in the document
3. Add section/subsection headings or navigation path to situate this chunk within the document structure
4. Include any definitions of technical terms, acronyms, or jargon used in this chunk
5. If this chunk references specific configurations, include relevant parameter explanations
6. Keep the original chunk text COMPLETELY INTACT and UNCHANGED in your response
7. The total length should be between {min_tokens} and {max_tokens} tokens
8. Format the response maintaining any hierarchical structure present in the original

Provide ONLY the enriched chunk text in your response:`;

export const MATH_PDF_PROMPT_TEMPLATE = `
<document>
{doc_content}
</document>

Here is the chunk we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this chunk by adding critical surrounding context. This document contains mathematical content that requires special handling. Follow these guidelines:

1. Preserve ALL mathematical notation exactly as it appears in the chunk
2. Include any defining equations, variables, or parameters mentioned earlier in the document that relate to this chunk
3. Add section/subsection names or figure references if they help situate the chunk
4. If variables or symbols are defined elsewhere in the document, include these definitions
5. If mathematical expressions appear corrupted, try to infer their meaning from context
6. Keep the original chunk text COMPLETELY INTACT and UNCHANGED in your response
7. The total length should be between {min_tokens} and {max_tokens} tokens
8. Format the response as a coherent mathematical explanation

Provide ONLY the enriched chunk text in your response:`;

export const CODE_PROMPT_TEMPLATE = `
<document>
{doc_content}
</document>

Here is the chunk of code we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this code chunk by adding critical surrounding context. Follow these guidelines:

1. Preserve ALL code syntax, indentation, and comments exactly as they appear
2. Include any import statements, function definitions, or class declarations that this code depends on
3. Add necessary type definitions or interfaces that are referenced in this chunk
4. Include any crucial comments from elsewhere in the document that explain this code
5. If there are key variable declarations or initializations earlier in the document, include those
6. Keep the original chunk COMPLETELY INTACT and UNCHANGED in your response
7. The total length should be between {min_tokens} and {max_tokens} tokens
8. Do NOT include implementation details for functions that are only called but not defined in this chunk

Provide ONLY the enriched code chunk in your response:`;

export const TECHNICAL_PROMPT_TEMPLATE = `
<document>
{doc_content}
</document>

Here is the chunk we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this chunk by adding critical surrounding context. This appears to be technical documentation that requires special handling. Follow these guidelines:

1. Preserve ALL technical terminology, product names, and version numbers exactly as they appear
2. Include any prerequisite information or requirements mentioned earlier in the document
3. Add section/subsection headings or navigation path to situate this chunk within the document structure
4. Include any definitions of technical terms, acronyms, or jargon used in this chunk
5. If this chunk references specific configurations, include relevant parameter explanations
6. Keep the original chunk text COMPLETELY INTACT and UNCHANGED in your response
7. The total length should be between {min_tokens} and {max_tokens} tokens
8. Format the response maintaining any hierarchical structure present in the original

Provide ONLY the enriched chunk text in your response:`;

export function getContextualizationPrompt(
  docContent: string,
  chunkContent: string,
  minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS,
  maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS,
  promptTemplate = CONTEXTUAL_CHUNK_ENRICHMENT_PROMPT_TEMPLATE
): string {
  if (!docContent || !chunkContent) {
    return "Error: Document or chunk content missing.";
  }

  const chunkTokens = Math.ceil(chunkContent.length / DEFAULT_CHARS_PER_TOKEN);

  if (chunkTokens > maxTokens * 0.7) {
    maxTokens = Math.ceil(chunkTokens * 1.3);
    minTokens = chunkTokens;
  }

  return promptTemplate
    .replace("{doc_content}", docContent)
    .replace("{chunk_content}", chunkContent)
    .replace("{min_tokens}", minTokens.toString())
    .replace("{max_tokens}", maxTokens.toString());
}

export function getCachingContextualizationPrompt(
  chunkContent: string,
  contentType?: string,
  minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS,
  maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS
): { prompt: string; systemPrompt: string } {
  if (!chunkContent) {
    return {
      prompt: "Error: Chunk content missing.",
      systemPrompt: SYSTEM_PROMPTS.DEFAULT,
    };
  }

  const chunkTokens = Math.ceil(chunkContent.length / DEFAULT_CHARS_PER_TOKEN);

  if (chunkTokens > maxTokens * 0.7) {
    maxTokens = Math.ceil(chunkTokens * 1.3);
    minTokens = chunkTokens;
  }
  let promptTemplate = CACHED_CHUNK_PROMPT_TEMPLATE;
  let systemPrompt = SYSTEM_PROMPTS.DEFAULT;

  if (contentType) {
    if (
      contentType.includes("javascript") ||
      contentType.includes("typescript") ||
      contentType.includes("python") ||
      contentType.includes("java") ||
      contentType.includes("c++") ||
      contentType.includes("code")
    ) {
      promptTemplate = CACHED_CODE_CHUNK_PROMPT_TEMPLATE;
      systemPrompt = SYSTEM_PROMPTS.CODE;
    } else if (contentType.includes("pdf")) {
      if (containsMathematicalContent(chunkContent)) {
        promptTemplate = CACHED_MATH_PDF_PROMPT_TEMPLATE;
        systemPrompt = SYSTEM_PROMPTS.MATH_PDF;
      } else {
        systemPrompt = SYSTEM_PROMPTS.PDF;
      }
    } else if (
      contentType.includes("markdown") ||
      contentType.includes("text/html") ||
      isTechnicalDocumentation(chunkContent)
    ) {
      promptTemplate = CACHED_TECHNICAL_PROMPT_TEMPLATE;
      systemPrompt = SYSTEM_PROMPTS.TECHNICAL;
    }
  }

  const formattedPrompt = promptTemplate
    .replace("{chunk_content}", chunkContent)
    .replace("{min_tokens}", minTokens.toString())
    .replace("{max_tokens}", maxTokens.toString());

  return {
    prompt: formattedPrompt,
    systemPrompt,
  };
}

export function getPromptForMimeType(
  mimeType: string,
  docContent: string,
  chunkContent: string
): string {
  let minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS;
  let maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS;
  let promptTemplate = CONTEXTUAL_CHUNK_ENRICHMENT_PROMPT_TEMPLATE;

  if (mimeType.includes("pdf")) {
    if (containsMathematicalContent(docContent)) {
      minTokens = CONTEXT_TARGETS.MATH_PDF.MIN_TOKENS;
      maxTokens = CONTEXT_TARGETS.MATH_PDF.MAX_TOKENS;
      promptTemplate = MATH_PDF_PROMPT_TEMPLATE;
    } else {
      minTokens = CONTEXT_TARGETS.PDF.MIN_TOKENS;
      maxTokens = CONTEXT_TARGETS.PDF.MAX_TOKENS;
    }
  } else if (
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("python") ||
    mimeType.includes("java") ||
    mimeType.includes("c++") ||
    mimeType.includes("code")
  ) {
    minTokens = CONTEXT_TARGETS.CODE.MIN_TOKENS;
    maxTokens = CONTEXT_TARGETS.CODE.MAX_TOKENS;
    promptTemplate = CODE_PROMPT_TEMPLATE;
  } else if (
    isTechnicalDocumentation(docContent) ||
    mimeType.includes("markdown") ||
    mimeType.includes("text/html")
  ) {
    minTokens = CONTEXT_TARGETS.TECHNICAL.MIN_TOKENS;
    maxTokens = CONTEXT_TARGETS.TECHNICAL.MAX_TOKENS;
    promptTemplate = TECHNICAL_PROMPT_TEMPLATE;
  }

  return getContextualizationPrompt(docContent, chunkContent, minTokens, maxTokens, promptTemplate);
}

export function getCachingPromptForMimeType(
  mimeType: string,
  chunkContent: string
): { prompt: string; systemPrompt: string } {
  let minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS;
  let maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS;
  if (mimeType.includes("pdf")) {
    if (containsMathematicalContent(chunkContent)) {
      minTokens = CONTEXT_TARGETS.MATH_PDF.MIN_TOKENS;
      maxTokens = CONTEXT_TARGETS.MATH_PDF.MAX_TOKENS;
    } else {
      minTokens = CONTEXT_TARGETS.PDF.MIN_TOKENS;
      maxTokens = CONTEXT_TARGETS.PDF.MAX_TOKENS;
    }
  } else if (
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("python") ||
    mimeType.includes("java") ||
    mimeType.includes("c++") ||
    mimeType.includes("code")
  ) {
    minTokens = CONTEXT_TARGETS.CODE.MIN_TOKENS;
    maxTokens = CONTEXT_TARGETS.CODE.MAX_TOKENS;
  } else if (
    isTechnicalDocumentation(chunkContent) ||
    mimeType.includes("markdown") ||
    mimeType.includes("text/html")
  ) {
    minTokens = CONTEXT_TARGETS.TECHNICAL.MIN_TOKENS;
    maxTokens = CONTEXT_TARGETS.TECHNICAL.MAX_TOKENS;
  }

  return getCachingContextualizationPrompt(chunkContent, mimeType, minTokens, maxTokens);
}

function containsMathematicalContent(content: string): boolean {
  const latexMathPatterns = [
    /\$\$.+?\$\$/s,
    /\$.+?\$/g,
    /\\begin\{equation\}/,
    /\\begin\{align\}/,
    /\\sum_/,
    /\\int/,
    /\\frac\{/,
    /\\sqrt\{/,
    /\\alpha|\\beta|\\gamma|\\delta|\\theta|\\lambda|\\sigma/,
    /\\nabla|\\partial/,
  ];
  const generalMathPatterns = [
    /[≠≤≥±∞∫∂∑∏√∈∉⊆⊇⊂⊃∪∩]/,
    /\b[a-zA-Z]\^[0-9]/,
    /\(\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*\)/,
    /\b[xyz]\s*=\s*-?\d+(\.\d+)?/,
    /\[\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*\]/,
    /\b\d+\s*×\s*\d+/,
  ];
  for (const pattern of latexMathPatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }

  // Test for general math patterns
  for (const pattern of generalMathPatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }

  // Keyword analysis
  const mathKeywords = [
    "theorem",
    "lemma",
    "proof",
    "equation",
    "function",
    "derivative",
    "integral",
    "matrix",
    "vector",
    "algorithm",
    "constraint",
    "coefficient",
  ];

  const contentLower = content.toLowerCase();
  const mathKeywordCount = mathKeywords.filter((keyword) => contentLower.includes(keyword)).length;

  return mathKeywordCount >= 2;
}

function isTechnicalDocumentation(content: string): boolean {
  const technicalPatterns = [
    /\b(version|v)\s*\d+\.\d+(\.\d+)?/i,
    /\b(api|sdk|cli)\b/i,
    /\b(http|https|ftp):\/\//i,
    /\b(GET|POST|PUT|DELETE)\b/,
    /<\/?[a-z][\s\S]*>/i,
    /\bREADME\b|\bCHANGELOG\b/i,
    /\b(config|configuration)\b/i,
    /\b(parameter|param|argument|arg)\b/i,
  ];

  const docHeadings = [
    /\b(Introduction|Overview|Getting Started|Installation|Usage|API Reference|Troubleshooting)\b/i,
  ];
  for (const pattern of [...technicalPatterns, ...docHeadings]) {
    if (pattern.test(content)) {
      return true;
    }
  }

  const listPatterns = [/\d+\.\s.+\n\d+\.\s.+/, /•\s.+\n•\s.+/, /\*\s.+\n\*\s.+/, /-\s.+\n-\s.+/];

  for (const pattern of listPatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }

  return false;
}

export function getChunkWithContext(chunkContent: string, generatedContext: string): string {
  if (!generatedContext || generatedContext.trim() === "") {
    return chunkContent;
  }
  return generatedContext.trim();
}
