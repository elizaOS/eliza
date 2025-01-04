import { elizaLogger, models } from "@elizaos/core";
import { Service } from "@elizaos/core";
import {
    IAgentRuntime,
    ModelProviderName,
    ServiceType,
    IImageDescriptionService,
} from "@elizaos/core";
import {
    AutoProcessor,
    AutoTokenizer,
    env,
    Florence2ForConditionalGeneration,
    Florence2Processor,
    PreTrainedModel,
    PreTrainedTokenizer,
    RawImage,
    type Tensor,
} from "@huggingface/transformers";
import fs from "fs";
import gifFrames from "gif-frames";
import os from "os";
import path from "path";

export class ImageDescriptionService
    extends Service
    implements IImageDescriptionService
{
    static serviceType: ServiceType = ServiceType.IMAGE_DESCRIPTION;

    private modelId: string = "onnx-community/Florence-2-base-ft";
    private device: string = "gpu";
    private model: PreTrainedModel | null = null;
    private processor: Florence2Processor | null = null;
    private tokenizer: PreTrainedTokenizer | null = null;
    private initialized: boolean = false;
    private runtime: IAgentRuntime | null = null;
    private queue: string[] = [];
    private processing: boolean = false;

    getInstance(): IImageDescriptionService {
        return ImageDescriptionService.getInstance();
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        elizaLogger.log("Initializing ImageDescriptionService");
        this.runtime = runtime;
    }

    private async initializeLocalModel(): Promise<void> {
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

        elizaLogger.success("Florence model downloaded successfully");

        elizaLogger.info("Downloading processor...");
        this.processor = (await AutoProcessor.from_pretrained(
            this.modelId
        )) as Florence2Processor;

        elizaLogger.info("Downloading tokenizer...");
        this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
        elizaLogger.success("Image service initialization complete");
    }

    async describeImage(
        imageUrl: string
    ): Promise<{ title: string; description: string }> {
        if (!this.initialized) {
            const model = models[this.runtime?.character?.modelProvider];

            if (model === models[ModelProviderName.LLAMALOCAL]) {
                await this.initializeLocalModel();
            } else {
                this.modelId = "gpt-4o-mini";
                this.device = "cloud";
            }

            this.initialized = true;
        }

        if (this.device === "cloud") {
            if (!this.runtime) {
                throw new Error(
                    "Runtime is required for OpenAI image recognition"
                );
            }
            return this.recognizeWithOpenAI(imageUrl);
        }

        this.queue.push(imageUrl);
        this.processQueue();

        return new Promise((resolve, _reject) => {
            const checkQueue = () => {
                const index = this.queue.indexOf(imageUrl);
                if (index !== -1) {
                    setTimeout(checkQueue, 100);
                } else {
                    resolve(this.processImage(imageUrl));
                }
            };
            checkQueue();
        });
    }

    private async recognizeWithOpenAI(
        imageUrl: string
    ): Promise<{ title: string; description: string }> {
        const isGif = imageUrl.toLowerCase().endsWith(".gif");
        let imageData: Buffer | null = null;

        try {
            if (isGif) {
                const { filePath } =
                    await this.extractFirstFrameFromGif(imageUrl);
                imageData = fs.readFileSync(filePath);
            } else if (fs.existsSync(imageUrl)) {
                imageData = fs.readFileSync(imageUrl);
            } else {
                const response = await fetch(imageUrl);
                if (!response.ok) {
                    throw new Error(
                        `Failed to fetch image: ${response.statusText}`
                    );
                }
                imageData = Buffer.from(await response.arrayBuffer());
            }

            if (!imageData || imageData.length === 0) {
                throw new Error("Failed to fetch image data");
            }

            const prompt =
                "Describe this image and give it a title. The first line should be the title, and then a line break, then a detailed description of the image. Respond with the format 'title\ndescription'";
            const text = await this.requestOpenAI(
                imageUrl,
                imageData,
                prompt,
                isGif,
                true
            );

            const [title, ...descriptionParts] = text.split("\n");
            return {
                title,
                description: descriptionParts.join("\n"),
            };
        } catch (error) {
            elizaLogger.error("Error in recognizeWithOpenAI:", error);
            throw error;
        }
    }

    private async requestOpenAI(
        imageUrl: string,
        imageData: Buffer,
        prompt: string,
        isGif: boolean = false,
        isLocalFile: boolean = false
    ): Promise<string> {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const shouldUseBase64 = (isGif || isLocalFile)&& !(this.runtime.imageModelProvider === ModelProviderName.OPENAI);
                const mimeType = isGif
                    ? "png"
                    : path.extname(imageUrl).slice(1) || "jpeg";

                const base64Data = imageData.toString("base64");
                const imageUrlToUse = shouldUseBase64
                    ? `data:image/${mimeType};base64,${base64Data}`
                    : imageUrl;

                const content = [
                    { type: "text", text: prompt },
                    {
                        type: "image_url",
                        image_url: {
                            url: imageUrlToUse,
                        },
                    },
                ];
                // If model provider is openai, use the endpoint, otherwise use the default openai endpoint.
                const endpoint =
                    this.runtime.imageModelProvider === ModelProviderName.OPENAI
                    ? models[this.runtime.imageModelProvider].endpoint
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
                        max_tokens: shouldUseBase64 ? 500 : 300,
                    }),
                });

                if (!response.ok) {
                    const responseText = await response.text();
                    elizaLogger.error(
                        "OpenAI API error:",
                        response.status,
                        "-",
                        responseText
                    );
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = await response.json();
                return data.choices[0].message.content;
            } catch (error) {
                elizaLogger.error(
                    "OpenAI request failed (attempt",
                    attempt + 1,
                    "):",
                    error
                );
                if (attempt === 2) throw error;
            }
        }
        throw new Error(
            "Failed to recognize image with OpenAI after 3 attempts"
        );
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        while (this.queue.length > 0) {
            const imageUrl = this.queue.shift();
            await this.processImage(imageUrl);
        }
        this.processing = false;
    }

    private async processImage(
        imageUrl: string
    ): Promise<{ title: string; description: string }> {
        if (!this.model || !this.processor || !this.tokenizer) {
            throw new Error("Model components not initialized");
        }

        elizaLogger.log("Processing image:", imageUrl);
        const isGif = imageUrl.toLowerCase().endsWith(".gif");
        let imageToProcess = imageUrl;

        try {
            if (isGif) {
                elizaLogger.log("Extracting first frame from GIF");
                const { filePath } =
                    await this.extractFirstFrameFromGif(imageUrl);
                imageToProcess = filePath;
            }

            const image = await RawImage.fromURL(imageToProcess);
            const visionInputs = await this.processor(image);
            const prompts =
                this.processor.construct_prompts("<DETAILED_CAPTION>");
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
        } catch (error) {
            elizaLogger.error("Error processing image:", error);
            throw error;
        } finally {
            if (isGif && imageToProcess !== imageUrl) {
                fs.unlinkSync(imageToProcess);
            }
        }
    }

    private async extractFirstFrameFromGif(
        gifUrl: string
    ): Promise<{ filePath: string }> {
        const frameData = await gifFrames({
            url: gifUrl,
            frames: 1,
            outputType: "png",
        });

        const tempFilePath = path.join(
            os.tmpdir(),
            `gif_frame_${Date.now()}.png`
        );

        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(tempFilePath);
            frameData[0].getImage().pipe(writeStream);
            writeStream.on("finish", () => resolve({ filePath: tempFilePath }));
            writeStream.on("error", reject);
        });
    }
}

export default ImageDescriptionService;
