/**
 * Prompt templates and utilities for generating contextual embeddings.
 * Based on Anthropic's contextual retrieval techniques:
 * https://www.anthropic.com/news/contextual-retrieval
 * https://github.com/anthropics/anthropic-cookbook/blob/main/skills/contextual-embeddings/guide.ipynb
 */

/**
 * Default token size settings for chunking and context generation.
 * These values have been adjusted based on research findings:
 * - Average chunk sizes of 400-600 tokens tend to work well for contextual embeddings
 * - Smaller chunks improve retrieval precision over larger ones
 * - Overlap should be meaningful to maintain context between chunks
 */
export const DEFAULT_CHUNK_TOKEN_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;
export const DEFAULT_CHARS_PER_TOKEN = 3.5; // Approximation for English text

/**
 * Target context sizes for different document types.
 * Based on Anthropic's research, contextual enrichment typically adds 50-100 tokens.
 */
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

/**
 * Modern system prompt for contextual embeddings based on Anthropic's guidelines.
 * This system prompt is more concise and focused on the specific task.
 */
export const SYSTEM_PROMPT =
  'You are a precision text augmentation tool. Your task is to expand a given text chunk with its direct context from a larger document. You must: 1) Keep the original chunk intact; 2) Add critical context from surrounding text; 3) Never summarize or rephrase the original chunk; 4) Create contextually rich output for improved semantic retrieval.';

/**
 * System prompts optimized for different content types with caching support
 */
export const SYSTEM_PROMPTS = {
  DEFAULT:
    'You are a precision text augmentation tool. Your task is to expand a given text chunk with its direct context from a larger document. You must: 1) Keep the original chunk intact; 2) Add critical context from surrounding text; 3) Never summarize or rephrase the original chunk; 4) Create contextually rich output for improved semantic retrieval.',

  CODE: 'You are a precision code augmentation tool. Your task is to expand a given code chunk with necessary context from the larger codebase. You must: 1) Keep the original code chunk intact with exact syntax and indentation; 2) Add relevant imports, function signatures, or class definitions; 3) Include critical surrounding code context; 4) Create contextually rich output that maintains correct syntax.',

  PDF: "You are a precision document augmentation tool. Your task is to expand a given PDF text chunk with its direct context from the larger document. You must: 1) Keep the original chunk intact; 2) Add section headings, references, or figure captions; 3) Include text that immediately precedes and follows the chunk; 4) Create contextually rich output that maintains the document's original structure.",

  MATH_PDF:
    'You are a precision mathematical content augmentation tool. Your task is to expand a given mathematical text chunk with essential context. You must: 1) Keep original mathematical notations and expressions exactly as they appear; 2) Add relevant definitions, theorems, or equations from elsewhere in the document; 3) Preserve all LaTeX or mathematical formatting; 4) Create contextually rich output for improved mathematical comprehension.',

  TECHNICAL:
    'You are a precision technical documentation augmentation tool. Your task is to expand a technical document chunk with critical context. You must: 1) Keep the original chunk intact including all technical terminology; 2) Add relevant configuration examples, parameter definitions, or API references; 3) Include any prerequisite information; 4) Create contextually rich output that maintains technical accuracy.',
};

/**
 * Enhanced contextual embedding prompt template optimized for better retrieval performance.
 * Based on Anthropic's research showing significant improvements in retrieval accuracy.
 */
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

/**
 * Caching-optimized chunk prompt - separates document from instructions
 * This version doesn't include the document inline to support OpenRouter caching
 */
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

/**
 * Caching-optimized code chunk prompt
 */
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

/**
 * Caching-optimized math PDF chunk prompt
 */
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

/**
 * Caching-optimized technical documentation chunk prompt
 */
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

/**
 * Specialized prompt for PDF documents with mathematical content
 */
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

/**
 * Specialized prompt for code documents
 */
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

/**
 * Specialized prompt for technical documentation
 */
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

/**
 * Generates the full prompt string for requesting contextual enrichment from an LLM.
 *
 * @param docContent - The full content of the document.
 * @param chunkContent - The content of the specific chunk to be contextualized.
 * @param minTokens - Minimum target token length for the result.
 * @param maxTokens - Maximum target token length for the result.
 * @returns The formatted prompt string.
 */
export function getContextualizationPrompt(
  docContent: string,
  chunkContent: string,
  minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS,
  maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS,
  promptTemplate = CONTEXTUAL_CHUNK_ENRICHMENT_PROMPT_TEMPLATE
): string {
  if (!docContent || !chunkContent) {
    console.warn('Document content or chunk content is missing for contextualization.');
    return 'Error: Document or chunk content missing.';
  }

  // Estimate if the chunk is already large relative to our target size
  const chunkTokens = Math.ceil(chunkContent.length / DEFAULT_CHARS_PER_TOKEN);

  // If the chunk is already large, adjust the target max tokens to avoid excessive growth
  if (chunkTokens > maxTokens * 0.7) {
    // Allow for only ~30% growth for large chunks
    maxTokens = Math.ceil(chunkTokens * 1.3);
    minTokens = chunkTokens;
  }

  return promptTemplate
    .replace('{doc_content}', docContent)
    .replace('{chunk_content}', chunkContent)
    .replace('{min_tokens}', minTokens.toString())
    .replace('{max_tokens}', maxTokens.toString());
}

/**
 * Generates a caching-compatible prompt string for contextual enrichment.
 * This separates the document from the chunk instructions to support OpenRouter caching.
 *
 * @param chunkContent - The content of the specific chunk to be contextualized.
 * @param contentType - Optional content type to determine specialized prompts.
 * @param minTokens - Minimum target token length for the result.
 * @param maxTokens - Maximum target token length for the result.
 * @returns Object containing the prompt and appropriate system message.
 */
export function getCachingContextualizationPrompt(
  chunkContent: string,
  contentType?: string,
  minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS,
  maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS
): { prompt: string; systemPrompt: string } {
  if (!chunkContent) {
    console.warn('Chunk content is missing for contextualization.');
    return {
      prompt: 'Error: Chunk content missing.',
      systemPrompt: SYSTEM_PROMPTS.DEFAULT,
    };
  }

  // Estimate if the chunk is already large relative to our target size
  const chunkTokens = Math.ceil(chunkContent.length / DEFAULT_CHARS_PER_TOKEN);

  // If the chunk is already large, adjust the target max tokens to avoid excessive growth
  if (chunkTokens > maxTokens * 0.7) {
    // Allow for only ~30% growth for large chunks
    maxTokens = Math.ceil(chunkTokens * 1.3);
    minTokens = chunkTokens;
  }

  // Determine content type and corresponding templates
  let promptTemplate = CACHED_CHUNK_PROMPT_TEMPLATE;
  let systemPrompt = SYSTEM_PROMPTS.DEFAULT;

  if (contentType) {
    if (
      contentType.includes('javascript') ||
      contentType.includes('typescript') ||
      contentType.includes('python') ||
      contentType.includes('java') ||
      contentType.includes('c++') ||
      contentType.includes('code')
    ) {
      promptTemplate = CACHED_CODE_CHUNK_PROMPT_TEMPLATE;
      systemPrompt = SYSTEM_PROMPTS.CODE;
    } else if (contentType.includes('pdf')) {
      if (containsMathematicalContent(chunkContent)) {
        promptTemplate = CACHED_MATH_PDF_PROMPT_TEMPLATE;
        systemPrompt = SYSTEM_PROMPTS.MATH_PDF;
      } else {
        systemPrompt = SYSTEM_PROMPTS.PDF;
      }
    } else if (
      contentType.includes('markdown') ||
      contentType.includes('text/html') ||
      isTechnicalDocumentation(chunkContent)
    ) {
      promptTemplate = CACHED_TECHNICAL_PROMPT_TEMPLATE;
      systemPrompt = SYSTEM_PROMPTS.TECHNICAL;
    }
  }

  const formattedPrompt = promptTemplate
    .replace('{chunk_content}', chunkContent)
    .replace('{min_tokens}', minTokens.toString())
    .replace('{max_tokens}', maxTokens.toString());

  return {
    prompt: formattedPrompt,
    systemPrompt,
  };
}

/**
 * Generates mime-type specific prompts with optimized parameters for different content types.
 *
 * @param mimeType - The MIME type of the document (e.g., 'application/pdf', 'text/markdown').
 * @param docContent - The full content of the document.
 * @param chunkContent - The content of the specific chunk.
 * @returns The formatted prompt string with mime-type specific settings.
 */
export function getPromptForMimeType(
  mimeType: string,
  docContent: string,
  chunkContent: string
): string {
  let minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS;
  let maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS;
  let promptTemplate = CONTEXTUAL_CHUNK_ENRICHMENT_PROMPT_TEMPLATE;

  // Determine document type and apply appropriate settings
  if (mimeType.includes('pdf')) {
    // Check if PDF contains mathematical content
    if (containsMathematicalContent(docContent)) {
      minTokens = CONTEXT_TARGETS.MATH_PDF.MIN_TOKENS;
      maxTokens = CONTEXT_TARGETS.MATH_PDF.MAX_TOKENS;
      promptTemplate = MATH_PDF_PROMPT_TEMPLATE;
      console.debug('Using mathematical PDF prompt template');
    } else {
      minTokens = CONTEXT_TARGETS.PDF.MIN_TOKENS;
      maxTokens = CONTEXT_TARGETS.PDF.MAX_TOKENS;
      console.debug('Using standard PDF settings');
    }
  } else if (
    mimeType.includes('javascript') ||
    mimeType.includes('typescript') ||
    mimeType.includes('python') ||
    mimeType.includes('java') ||
    mimeType.includes('c++') ||
    mimeType.includes('code')
  ) {
    minTokens = CONTEXT_TARGETS.CODE.MIN_TOKENS;
    maxTokens = CONTEXT_TARGETS.CODE.MAX_TOKENS;
    promptTemplate = CODE_PROMPT_TEMPLATE;
    console.debug('Using code prompt template');
  } else if (
    isTechnicalDocumentation(docContent) ||
    mimeType.includes('markdown') ||
    mimeType.includes('text/html')
  ) {
    minTokens = CONTEXT_TARGETS.TECHNICAL.MIN_TOKENS;
    maxTokens = CONTEXT_TARGETS.TECHNICAL.MAX_TOKENS;
    promptTemplate = TECHNICAL_PROMPT_TEMPLATE;
    // Using technical documentation prompt template
  }

  return getContextualizationPrompt(docContent, chunkContent, minTokens, maxTokens, promptTemplate);
}

/**
 * Optimized version of getPromptForMimeType that separates document from prompt.
 * Returns structured data that supports OpenRouter caching.
 *
 * @param mimeType - The MIME type of the document.
 * @param chunkContent - The content of the specific chunk.
 * @returns Object containing prompt text and system message.
 */
export function getCachingPromptForMimeType(
  mimeType: string,
  chunkContent: string
): { prompt: string; systemPrompt: string } {
  let minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS;
  let maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS;

  // Determine appropriate token targets based on content type
  if (mimeType.includes('pdf')) {
    if (containsMathematicalContent(chunkContent)) {
      minTokens = CONTEXT_TARGETS.MATH_PDF.MIN_TOKENS;
      maxTokens = CONTEXT_TARGETS.MATH_PDF.MAX_TOKENS;
    } else {
      minTokens = CONTEXT_TARGETS.PDF.MIN_TOKENS;
      maxTokens = CONTEXT_TARGETS.PDF.MAX_TOKENS;
    }
  } else if (
    mimeType.includes('javascript') ||
    mimeType.includes('typescript') ||
    mimeType.includes('python') ||
    mimeType.includes('java') ||
    mimeType.includes('c++') ||
    mimeType.includes('code')
  ) {
    minTokens = CONTEXT_TARGETS.CODE.MIN_TOKENS;
    maxTokens = CONTEXT_TARGETS.CODE.MAX_TOKENS;
  } else if (
    isTechnicalDocumentation(chunkContent) ||
    mimeType.includes('markdown') ||
    mimeType.includes('text/html')
  ) {
    minTokens = CONTEXT_TARGETS.TECHNICAL.MIN_TOKENS;
    maxTokens = CONTEXT_TARGETS.TECHNICAL.MAX_TOKENS;
  }

  return getCachingContextualizationPrompt(chunkContent, mimeType, minTokens, maxTokens);
}

/**
 * Determines if a document likely contains mathematical content based on heuristics.
 *
 * @param content - The document content to analyze.
 * @returns True if the document appears to contain mathematical content.
 */
function containsMathematicalContent(content: string): boolean {
  // Check for LaTeX-style math notation
  const latexMathPatterns = [
    /\$\$.+?\$\$/s, // Display math: $$ ... $$
    /\$.+?\$/g, // Inline math: $ ... $
    /\\begin\{equation\}/, // LaTeX equation environment
    /\\begin\{align\}/, // LaTeX align environment
    /\\sum_/, // Summation
    /\\int/, // Integral
    /\\frac\{/, // Fraction
    /\\sqrt\{/, // Square root
    /\\alpha|\\beta|\\gamma|\\delta|\\theta|\\lambda|\\sigma/, // Greek letters
    /\\nabla|\\partial/, // Differential operators
  ];

  // Check for common non-LaTeX mathematical patterns
  const generalMathPatterns = [
    /[≠≤≥±∞∫∂∑∏√∈∉⊆⊇⊂⊃∪∩]/, // Mathematical symbols
    /\b[a-zA-Z]\^[0-9]/, // Simple exponents (e.g., x^2)
    /\(\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*\)/, // Coordinates
    /\b[xyz]\s*=\s*-?\d+(\.\d+)?/, // Simple equations
    /\[\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*\]/, // Vectors/matrices
    /\b\d+\s*×\s*\d+/, // Dimensions with × symbol
  ];

  // Test for LaTeX patterns
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
    'theorem',
    'lemma',
    'proof',
    'equation',
    'function',
    'derivative',
    'integral',
    'matrix',
    'vector',
    'algorithm',
    'constraint',
    'coefficient',
  ];

  const contentLower = content.toLowerCase();
  const mathKeywordCount = mathKeywords.filter((keyword) => contentLower.includes(keyword)).length;

  // If multiple math keywords are present, it likely contains math
  return mathKeywordCount >= 2;
}

/**
 * Determines if a document is technical documentation based on heuristics.
 *
 * @param content - The document content to analyze.
 * @returns True if the document appears to be technical documentation.
 */
function isTechnicalDocumentation(content: string): boolean {
  // Technical documentation patterns
  const technicalPatterns = [
    /\b(version|v)\s*\d+\.\d+(\.\d+)?/i, // Version numbers
    /\b(api|sdk|cli)\b/i, // Technical acronyms
    /\b(http|https|ftp):\/\//i, // URLs
    /\b(GET|POST|PUT|DELETE)\b/, // HTTP methods
    /<\/?[a-z][\s\S]*>/i, // HTML/XML tags
    /\bREADME\b|\bCHANGELOG\b/i, // Common doc file names
    /\b(config|configuration)\b/i, // Configuration references
    /\b(parameter|param|argument|arg)\b/i, // Parameter references
  ];

  // Check for common technical documentation headings
  const docHeadings = [
    /\b(Introduction|Overview|Getting Started|Installation|Usage|API Reference|Troubleshooting)\b/i,
  ];

  // Check for patterns that suggest it's documentation
  for (const pattern of [...technicalPatterns, ...docHeadings]) {
    if (pattern.test(content)) {
      return true;
    }
  }

  // Check for patterns of numbered or bullet point lists which are common in documentation
  const listPatterns = [
    /\d+\.\s.+\n\d+\.\s.+/, // Numbered lists
    /•\s.+\n•\s.+/, // Bullet points with •
    /\*\s.+\n\*\s.+/, // Bullet points with *
    /-\s.+\n-\s.+/, // Bullet points with -
  ];

  for (const pattern of listPatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }

  return false;
}

/**
 * Combines the original chunk content with its generated contextual enrichment.
 *
 * @param chunkContent - The original content of the chunk.
 * @param generatedContext - The contextual enrichment generated by the LLM.
 * @returns The enriched chunk, or the original chunkContent if the enrichment is empty.
 */
export function getChunkWithContext(chunkContent: string, generatedContext: string): string {
  if (!generatedContext || generatedContext.trim() === '') {
    console.warn('Generated context is empty. Falling back to original chunk content.');
    return chunkContent;
  }

  return generatedContext.trim();
}
