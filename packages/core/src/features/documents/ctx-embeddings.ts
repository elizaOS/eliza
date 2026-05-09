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

type ContentType = "default" | "code" | "pdf" | "math" | "technical";

const SYSTEM_BASE =
	"Expand the given chunk with surrounding context. Keep the chunk verbatim. Output one coherent paragraph for semantic retrieval.";

const SYSTEM_TYPE_NOTES: Record<ContentType, string> = {
	default: "",
	code: " Preserve exact syntax and indentation; add relevant imports, signatures, or class definitions.",
	pdf: " Add section headings, references, or figure captions; preserve document structure.",
	math: " Preserve all mathematical notation and LaTeX exactly; add relevant definitions, theorems, or equations.",
	technical:
		" Preserve technical terminology, parameters, and version numbers; add prerequisite info and API references.",
};

const BASE_RULES = [
	"Keep the original chunk text COMPLETELY INTACT and UNCHANGED in your response",
	"The total length should be between {min_tokens} and {max_tokens} tokens",
	"Format the response as a single coherent paragraph",
];

const CONTENT_TYPE_RULES: Record<ContentType, string[]> = {
	default: [
		"Identify the document's main topic and key information relevant to understanding this chunk",
		"Include 2-3 sentences before the chunk that provide essential context",
		"Include 2-3 sentences after the chunk that complete thoughts or provide resolution",
		"For technical documents, include any definitions or explanations of terms used in the chunk",
		"For narrative content, include character or setting information needed to understand the chunk",
		'Do not use phrases like "this chunk discusses" - directly present the context',
	],
	code: [
		"Preserve ALL code syntax, indentation, and comments exactly as they appear",
		"Include any import statements, function definitions, or class declarations that this code depends on",
		"Add necessary type definitions or interfaces that are referenced in this chunk",
		"Include any crucial comments from elsewhere in the document that explain this code",
		"If there are key variable declarations or initializations earlier in the document, include those",
		"Do NOT include implementation details for functions that are only called but not defined in this chunk",
	],
	pdf: [
		"Identify the document's main topic and key information relevant to understanding this chunk",
		"Include section headings, references, or figure captions that situate this chunk",
		"Include text that immediately precedes and follows the chunk",
	],
	math: [
		"Preserve ALL mathematical notation exactly as it appears in the chunk",
		"Include any defining equations, variables, or parameters mentioned earlier in the document that relate to this chunk",
		"Add section/subsection names or figure references if they help situate the chunk",
		"If variables or symbols are defined elsewhere in the document, include these definitions",
		"If mathematical expressions appear corrupted, try to infer their meaning from context",
	],
	technical: [
		"Preserve ALL technical terminology, product names, and version numbers exactly as they appear",
		"Include any prerequisite information or requirements mentioned earlier in the document",
		"Add section/subsection headings or navigation path to situate this chunk within the document structure",
		"Include any definitions of technical terms, acronyms, or jargon used in this chunk",
		"If this chunk references specific configurations, include relevant parameter explanations",
	],
};

const CHUNK_LABEL: Record<ContentType, string> = {
	default: "chunk",
	code: "chunk of code",
	pdf: "chunk",
	math: "chunk",
	technical: "chunk",
};

const OUTPUT_LABEL: Record<ContentType, string> = {
	default: "enriched chunk text",
	code: "enriched code chunk",
	pdf: "enriched chunk text",
	math: "enriched chunk text",
	technical: "enriched chunk text",
};

interface BuildPromptArgs {
	contentType: ContentType;
	includeFullDocument: boolean;
}

export function buildEnrichmentSystemPrompt(args: {
	contentType: ContentType;
}): string {
	return SYSTEM_BASE + SYSTEM_TYPE_NOTES[args.contentType];
}

export function buildEnrichmentPrompt(args: BuildPromptArgs): string {
	const { contentType, includeFullDocument } = args;
	const docBlock = includeFullDocument
		? "\n<document>\n{doc_content}\n</document>\n\n"
		: "\n";
	const rules = [...CONTENT_TYPE_RULES[contentType], ...BASE_RULES];
	const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
	const chunkLabel = CHUNK_LABEL[contentType];
	const outputLabel = OUTPUT_LABEL[contentType];

	return `${docBlock}Here is the ${chunkLabel} we want to situate within the whole document:
<chunk>
{chunk_content}
</chunk>

Create an enriched version of this ${chunkLabel} by adding critical surrounding context. Follow these guidelines:

${numbered}

Provide ONLY the ${outputLabel} in your response:`;
}

// Back-compat shim exports — all derived from the builders above.
export const SYSTEM_PROMPT = buildEnrichmentSystemPrompt({
	contentType: "default",
});

export const SYSTEM_PROMPTS = {
	DEFAULT: buildEnrichmentSystemPrompt({ contentType: "default" }),
	CODE: buildEnrichmentSystemPrompt({ contentType: "code" }),
	PDF: buildEnrichmentSystemPrompt({ contentType: "pdf" }),
	MATH_PDF: buildEnrichmentSystemPrompt({ contentType: "math" }),
	TECHNICAL: buildEnrichmentSystemPrompt({ contentType: "technical" }),
};

export const CONTEXTUAL_CHUNK_ENRICHMENT_PROMPT_TEMPLATE = buildEnrichmentPrompt(
	{ contentType: "default", includeFullDocument: true },
);
export const CACHED_CHUNK_PROMPT_TEMPLATE = buildEnrichmentPrompt({
	contentType: "default",
	includeFullDocument: false,
});
export const CACHED_CODE_CHUNK_PROMPT_TEMPLATE = buildEnrichmentPrompt({
	contentType: "code",
	includeFullDocument: false,
});
export const CACHED_MATH_PDF_PROMPT_TEMPLATE = buildEnrichmentPrompt({
	contentType: "math",
	includeFullDocument: false,
});
export const CACHED_TECHNICAL_PROMPT_TEMPLATE = buildEnrichmentPrompt({
	contentType: "technical",
	includeFullDocument: false,
});
export const MATH_PDF_PROMPT_TEMPLATE = buildEnrichmentPrompt({
	contentType: "math",
	includeFullDocument: true,
});
export const CODE_PROMPT_TEMPLATE = buildEnrichmentPrompt({
	contentType: "code",
	includeFullDocument: true,
});
export const TECHNICAL_PROMPT_TEMPLATE = buildEnrichmentPrompt({
	contentType: "technical",
	includeFullDocument: true,
});

export function getContextualizationPrompt(
	docContent: string,
	chunkContent: string,
	minTokens = CONTEXT_TARGETS.DEFAULT.MIN_TOKENS,
	maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS,
	promptTemplate = CONTEXTUAL_CHUNK_ENRICHMENT_PROMPT_TEMPLATE,
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
	maxTokens = CONTEXT_TARGETS.DEFAULT.MAX_TOKENS,
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
	chunkContent: string,
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

	return getContextualizationPrompt(
		docContent,
		chunkContent,
		minTokens,
		maxTokens,
		promptTemplate,
	);
}

export function getCachingPromptForMimeType(
	mimeType: string,
	chunkContent: string,
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

	return getCachingContextualizationPrompt(
		chunkContent,
		mimeType,
		minTokens,
		maxTokens,
	);
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

	for (const pattern of generalMathPatterns) {
		if (pattern.test(content)) {
			return true;
		}
	}

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
	const mathKeywordCount = mathKeywords.filter((keyword) =>
		contentLower.includes(keyword),
	).length;

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

	const listPatterns = [
		/\d+\.\s.+\n\d+\.\s.+/,
		/•\s.+\n•\s.+/,
		/\*\s.+\n\*\s.+/,
		/-\s.+\n-\s.+/,
	];

	for (const pattern of listPatterns) {
		if (pattern.test(content)) {
			return true;
		}
	}

	return false;
}

export function getChunkWithContext(
	chunkContent: string,
	generatedContext: string,
): string {
	if (!generatedContext || generatedContext.trim() === "") {
		return chunkContent;
	}
	return generatedContext.trim();
}
