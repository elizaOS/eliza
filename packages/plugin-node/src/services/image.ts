import {
    elizaLogger,
    getEndpoint,
    type IAgentRuntime,
    type IImageDescriptionService,
    ModelProviderName,
    models,
    Service,
    ServiceType,
} from "@elizaos/core";
import {
    AutoProcessor,
    AutoTokenizer,
    env,
    Florence2ForConditionalGeneration,
    type Florence2Processor,
    type PreTrainedModel,
    type PreTrainedTokenizer,
    RawImage,
    type Tensor,
} from "@huggingface/transformers";
import sharp, { type AvailableFormatInfo, type FormatEnum } from "sharp";
import fs from "fs";
import os from "os";
import path from "path";

const IMAGE_DESCRIPTION_PROMPT =
    "Describe this image and give it a title. The first line should be the title, and then a line break, then a detailed description of the image. Respond with the format 'title\\ndescription'";

interface ImageProvider {
    initialize(): Promise<void>;
    describeImage(
        imageData: Buffer,
        mimeType: string
    ): Promise<{ title: string; description: string }>;
}

// Utility functions
const convertToBase64DataUrl = (
    imageData: Buffer,
    mimeType: string
): string => {
    const base64Data = imageData.toString("base64");
    return `data:${mimeType};base64,${base64Data}`;
};

const handleApiError = async (
    response: Response,
    provider: string
): Promise<never> => {
    const responseText = await response.text();
    elizaLogger.error(
        `${provider} API error:`,
        response.status,
        "-",
        responseText
    );
    throw new Error(`HTTP error! status: ${response.status}`);
};

const parseImageResponse = (
    text: string
): { title: string; description: string } => {
    const [title, ...descriptionParts] = text.split("\n");
    return { title, description: descriptionParts.join("\n") };
};

class LocalImageProvider implements ImageProvider {
    private model: PreTrainedModel | null = null;
    private processor: Florence2Processor | null = null;
    private tokenizer: PreTrainedTokenizer | null = null;
    private modelId = "onnx-community/Florence-2-base-ft";

    async initialize(): Promise<void> {
        env.allowLocalModels = false;
        env.allowRemoteModels = true;
        env.backends.onnx.logLevel = "fatal";
        env.backends.onnx.wasm.proxy = false;
        env.backends.onnx.wasm.numThreads = 1;

        elizaLogger.info("Downloading Florence model...");
        this.model = await Florence2ForConditionalGeneration.from_pretrained(
            this.modelId,
            {
                device: "gpu",
                progress_callback: (progress) => {
                    if (progress.status === "downloading") {
                        const percent = (
                            (progress.loaded / progress.total) *
                            100
                        ).toFixed(1);
                        const dots = ".".repeat(
                            Math.floor(Number(percent) / 5)
                        );
                        elizaLogger.info(
                            `Downloading Florence model: [${dots.padEnd(20, " ")}] ${percent}%`
                        );
                    }
                },
            }
        );

        elizaLogger.info("Downloading processor...");
        this.processor = (await AutoProcessor.from_pretrained(
            this.modelId
        )) as Florence2Processor;

        elizaLogger.info("Downloading tokenizer...");
        this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
        elizaLogger.success("Image service initialization complete");
    }

    async describeImage(
        imageData: Buffer,
        mimeType: string
    ): Promise<{ title: string; description: string }> {
        if (!this.model || !this.processor || !this.tokenizer) {
            throw new Error("Model components not initialized");
        }
        const blob = new Blob([imageData], { type: mimeType });
        const image = await RawImage.fromBlob(blob);
        const visionInputs = await this.processor(image);
        const prompts = this.processor.construct_prompts("<DETAILED_CAPTION>");
        const textInputs = this.tokenizer(prompts);

        elizaLogger.log("Generating image description");
        const generatedIds = (await this.model.generate({
            ...textInputs,
            ...visionInputs,
            max_new_tokens: 256,
        })) as Tensor;

        const generatedText = this.tokenizer.batch_decode(generatedIds, {
            skip_special_tokens: false,
        })[0];

        const result = this.processor.post_process_generation(
            generatedText,
            "<DETAILED_CAPTION>",
            image.size
        );

        const detailedCaption = result["<DETAILED_CAPTION>"] as string;
        return { title: detailedCaption, description: detailedCaption };
    }
}

class AnthropicImageProvider implements ImageProvider {
    constructor(private runtime: IAgentRuntime) {
    }

    async initialize(): Promise<void> {
    }

    async describeImage(
        imageData: Buffer,
        mimeType: string,
    ): Promise<{ title: string; description: string }> {
        const endpoint = getEndpoint(ModelProviderName.ANTHROPIC);
        const apiKey = this.runtime.getSetting("ANTHROPIC_API_KEY");

        const content = [
            {type: "text", text: IMAGE_DESCRIPTION_PROMPT},
            {
                type: "image",
                source: {
                    type: "base64",
                    media_type: mimeType,
                    data: imageData.toString("base64"),
                },
            },
        ];

        const response = await fetch(`${endpoint}/messages`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(
                {
                    model: "claude-3-haiku-20240307",
                    max_tokens: 1024,
                    messages: [{role: "user", content}],
                }),
        });

        if (!response.ok) {
            await handleApiError(response, "Anthropic");
        }

        const data = await response.json();
        return parseImageResponse(data.content[0].text);
    }
}

class OpenAIImageProvider implements ImageProvider {
    constructor(private runtime: IAgentRuntime) {}

    async initialize(): Promise<void> {}

    async describeImage(
        imageData: Buffer,
        mimeType: string
    ): Promise<{ title: string; description: string }> {
        const imageUrl = convertToBase64DataUrl(imageData, mimeType);

        const content = [
            { type: "text", text: IMAGE_DESCRIPTION_PROMPT },
            { type: "image_url", image_url: { url: imageUrl } },
        ];

        const endpoint =
            this.runtime.imageVisionModelProvider === ModelProviderName.OPENAI
                ? getEndpoint(this.runtime.imageVisionModelProvider)
                : "https://api.openai.com/v1";

        const response = await fetch(endpoint + "/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.runtime.getSetting("OPENAI_API_KEY")}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content }],
                max_tokens: 500,
            }),
        });

        if (!response.ok) {
            await handleApiError(response, "OpenAI");
        }

        const data = await response.json();
        return parseImageResponse(data.choices[0].message.content);
    }
}

class GroqImageProvider implements ImageProvider {
    constructor(private runtime: IAgentRuntime) {}

    async initialize(): Promise<void> {}

    async describeImage(
        imageData: Buffer,
        mimeType: string
    ): Promise<{ title: string; description: string }> {
        const imageUrl = convertToBase64DataUrl(imageData, mimeType);

        const content = [
            { type: "text", text: IMAGE_DESCRIPTION_PROMPT },
            { type: "image_url", image_url: { url: imageUrl } },
        ];

        const endpoint =
            this.runtime.imageVisionModelProvider === ModelProviderName.GROQ
                ? getEndpoint(this.runtime.imageVisionModelProvider)
                : "https://api.groq.com/openai/v1/";

        const response = await fetch(endpoint + "/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.runtime.getSetting("GROQ_API_KEY")}`,
            },
            body: JSON.stringify({
                model: /*this.runtime.imageVisionModelName ||*/ "llama-3.2-90b-vision-preview",
                messages: [{ role: "user", content }],
                max_tokens: 1024,
            }),
        });

        if (!response.ok) {
            await handleApiError(response, "Groq");
        }

        const data = await response.json();
        return parseImageResponse(data.choices[0].message.content);
    }
}

class GoogleImageProvider implements ImageProvider {
    constructor(private runtime: IAgentRuntime) {}

    async initialize(): Promise<void> {}

    async describeImage(
        imageData: Buffer,
        mimeType: string
    ): Promise<{ title: string; description: string }> {
        const endpoint = getEndpoint(ModelProviderName.GOOGLE);
        const apiKey = this.runtime.getSetting("GOOGLE_GENERATIVE_AI_API_KEY");

        const response = await fetch(
            `${endpoint}/v1/models/gemini-1.5-pro:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                { text: IMAGE_DESCRIPTION_PROMPT },
                                {
                                    inline_data: {
                                        mime_type: mimeType,
                                        data: imageData.toString("base64"),
                                    },
                                },
                            ],
                        },
                    ],
                }),
            }
        );

        if (!response.ok) {
            await handleApiError(response, "Google Gemini");
        }

        const data = await response.json();
        return parseImageResponse(data.candidates[0].content.parts[0].text);
    }
}

export class ImageDescriptionService
    extends Service
    implements IImageDescriptionService
{
    static serviceType: ServiceType = ServiceType.IMAGE_DESCRIPTION;

    private initialized = false;
    private runtime: IAgentRuntime | null = null;
    private provider: ImageProvider | null = null;

    getInstance(): IImageDescriptionService {
        return ImageDescriptionService.getInstance();
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        elizaLogger.log("Initializing ImageDescriptionService");
        this.runtime = runtime;
    }

    private async initializeProvider(): Promise<boolean> {
        if (!this.runtime) {
            throw new Error("Runtime is required for image recognition");
        }

        const availableModels = [
            ModelProviderName.LLAMALOCAL,
            ModelProviderName.ANTHROPIC,
            ModelProviderName.GOOGLE,
            ModelProviderName.OPENAI,
            ModelProviderName.GROQ,
        ].join(", ");

        const model = models[this.runtime?.character?.modelProvider];

        if (this.runtime.imageVisionModelProvider) {
            if (
                this.runtime.imageVisionModelProvider ===
                ModelProviderName.LLAMALOCAL ||
                this.runtime.imageVisionModelProvider ===
                ModelProviderName.OLLAMA
            ) {
                this.provider = new LocalImageProvider();
                elizaLogger.debug("Using local provider for vision model");
            } else if (
                this.runtime.imageVisionModelProvider ===
                ModelProviderName.ANTHROPIC
            ) {
                this.provider = new AnthropicImageProvider(this.runtime);
                elizaLogger.debug("Using anthropic for vision model");
            } else if (
                this.runtime.imageVisionModelProvider ===
                ModelProviderName.GOOGLE
            ) {
                this.provider = new GoogleImageProvider(this.runtime);
                elizaLogger.debug("Using google for vision model");
            } else if (
                this.runtime.imageVisionModelProvider ===
                ModelProviderName.OPENAI
            ) {
                this.provider = new OpenAIImageProvider(this.runtime);
                elizaLogger.debug("Using openai for vision model");
            } else if (
                this.runtime.imageVisionModelProvider === ModelProviderName.GROQ
            ) {
                this.provider = new GroqImageProvider(this.runtime);
                elizaLogger.debug("Using Groq for vision model");
            } else {
                elizaLogger.warn(
                    `Unsupported image vision model provider: ${this.runtime.imageVisionModelProvider}. ` +
                    `Please use one of the following: ${availableModels}. ` +
                    `Update the 'imageVisionModelProvider' field in the character file.`
                );
                return false;
            }
        } else if (
            model === models[ModelProviderName.LLAMALOCAL] ||
            model === models[ModelProviderName.OLLAMA]
        ) {
            this.provider = new LocalImageProvider();
            elizaLogger.debug("Using local provider for vision model");
        } else if (model === models[ModelProviderName.ANTHROPIC]) {
            this.provider = new AnthropicImageProvider(this.runtime);
            elizaLogger.debug("Using anthropic for vision model");
        } else if (model === models[ModelProviderName.GOOGLE]) {
            this.provider = new GoogleImageProvider(this.runtime);
            elizaLogger.debug("Using google for vision model");
        } else if (model === models[ModelProviderName.GROQ]) {
            this.provider = new GroqImageProvider(this.runtime);
            elizaLogger.debug("Using groq for vision model");
        } else {
            elizaLogger.debug("Using default openai for vision model");
            this.provider = new OpenAIImageProvider(this.runtime);
        }

        try {
            await this.provider.initialize();
        } catch {
            elizaLogger.error(
                `Failed to initialize the image vision model provider: ${this.runtime.imageVisionModelProvider}`
            );
            return false;
        }
        return true;
    }

    private async loadImageData(
        imageUrlOrPath: string
    ): Promise<{ data: Buffer; mimeType: string }> {
        let loadedImageData: Buffer;
        let loadedMimeType: string;
        const { imageData, mimeType } = await this.fetchImage(imageUrlOrPath);
        const skipConversion =
            mimeType === "image/jpeg" ||
            mimeType === "image/jpg" ||
            mimeType === "image/png";
        if (skipConversion) {
            loadedImageData = imageData;
            loadedMimeType = mimeType;
        } else {
            const converted = await this.convertImageDataToFormat(
                imageData,
                "png"
            );
            loadedImageData = converted.imageData;
            loadedMimeType = converted.mimeType;
        }
        if (!loadedImageData || loadedImageData.length === 0) {
            throw new Error("Failed to fetch image data");
        }
        return { data: loadedImageData, mimeType: loadedMimeType };
    }

    private async convertImageDataToFormat(
        data: Buffer,
        format: keyof FormatEnum | AvailableFormatInfo = "png"
    ): Promise<{ imageData: Buffer; mimeType: string }> {
        const tempFilePath = path.join(
            os.tmpdir(),
            `tmp_img_${Date.now()}.${format}`
        );
        try {
            await sharp(data).toFormat(format).toFile(tempFilePath);
            const { imageData, mimeType } = await this.fetchImage(tempFilePath);
            return {
                imageData,
                mimeType,
            };
        } finally {
            fs.unlinkSync(tempFilePath); // Clean up temp file
        }
    }

    private async fetchImage(
        imageUrlOrPath: string
    ): Promise<{ imageData: Buffer; mimeType: string }> {
        let imageData: Buffer;
        let mimeType: string;
        if (fs.existsSync(imageUrlOrPath)) {
            imageData = fs.readFileSync(imageUrlOrPath);
            const ext = path.extname(imageUrlOrPath).slice(1).toLowerCase();
            mimeType = ext ? `image/${ext}` : "image/jpeg";
        } else {
            const response = await fetch(imageUrlOrPath);
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch image: ${response.statusText}`
                );
            }
            imageData = Buffer.from(await response.arrayBuffer());
            mimeType = response.headers.get("content-type") || "image/jpeg";
        }
        return { imageData, mimeType };
    }

    async describeImage(
        imageUrlOrPath: string
    ): Promise<{ title: string; description: string }> {
        if (!this.initialized) {
            this.initialized = await this.initializeProvider();
        }

        if (this.initialized) {
            try {
                const { data, mimeType } =
                    await this.loadImageData(imageUrlOrPath);
                return await this.provider.describeImage(data, mimeType);
            } catch (error) {
                elizaLogger.error("Error in describeImage:", error);
                throw error;
            }
        }
    }
}

export default ImageDescriptionService;
