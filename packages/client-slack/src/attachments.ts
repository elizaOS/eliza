import {
    generateText,
    trimTokens,
    parseJSONObjectFromText,
} from "@elizaos/core";
import {
    IAgentRuntime,
    IImageDescriptionService,
    IPdfService,
    ITranscriptionService,
    IVideoService,
    Media,
    ModelClass,
    ServiceType,
} from "@elizaos/core";
import { WebClient } from "@slack/web-api";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

async function generateSummary(
    runtime: IAgentRuntime,
    text: string
): Promise<{ title: string; description: string }> {
    text = await trimTokens(text, 100000, runtime);

    const prompt = `Please generate a concise summary for the following text:

  Text: """
  ${text}
  """

  Respond with a JSON object in the following format:
  \`\`\`json
  {
    "title": "Generated Title",
    "summary": "Generated summary and/or description of the text"
  }
  \`\`\``;

    const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
    });

    const parsedResponse = parseJSONObjectFromText(response);

    if (parsedResponse) {
        return {
            title: parsedResponse.title,
            description: parsedResponse.summary,
        };
    }

    return {
        title: "",
        description: "",
    };
}

interface SlackFile {
    id: string;
    url_private: string;
    name: string;
    size: number;
    mimetype: string;
    title?: string;
}

export class AttachmentManager {
    private attachmentCache: Map<string, Media> = new Map();
    private runtime: IAgentRuntime;
    private client: WebClient;

    constructor(runtime: IAgentRuntime, client: WebClient) {
        this.runtime = runtime;
        this.client = client;
    }

    async processAttachments(files: SlackFile[]): Promise<Media[]> {
        const processedAttachments: Media[] = [];

        for (const file of files) {
            const media = await this.processAttachment(file);
            if (media) {
                processedAttachments.push(media);
            }
        }

        return processedAttachments;
    }

    async processAttachment(file: SlackFile): Promise<Media | null> {
        if (this.attachmentCache.has(file.url_private)) {
            return this.attachmentCache.get(file.url_private)!;
        }

        let media: Media | null = null;

        try {
            const videoService = this.runtime.getService<IVideoService>(
                ServiceType.VIDEO
            );

            if (file.mimetype.startsWith("application/pdf")) {
                media = await this.processPdfAttachment(file);
            } else if (file.mimetype.startsWith("text/plain")) {
                media = await this.processPlaintextAttachment(file);
            } else if (
                file.mimetype.startsWith("audio/") ||
                file.mimetype.startsWith("video/mp4")
            ) {
                media = await this.processAudioVideoAttachment(file);
            } else if (file.mimetype.startsWith("image/")) {
                media = await this.processImageAttachment(file);
            } else if (
                file.mimetype.startsWith("video/") ||
                (videoService?.isVideoUrl(file.url_private) ?? false)
            ) {
                media = await this.processVideoAttachment(file);
            } else {
                media = await this.processGenericAttachment(file);
            }

            if (media) {
                this.attachmentCache.set(file.url_private, media);
            }
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            console.error(`Error processing attachment: ${errorMessage}`);
            media = await this.processGenericAttachment(file);
        }

        return media;
    }

    private async fetchFileContent(file: SlackFile): Promise<Buffer> {
        const response = await fetch(file.url_private, {
            headers: {
                Authorization: `Bearer ${this.client.token}`,
            },
        });
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    private async processAudioVideoAttachment(file: SlackFile): Promise<Media> {
        try {
            const fileBuffer = await this.fetchFileContent(file);
            let audioBuffer: Buffer;

            if (file.mimetype.startsWith("audio/")) {
                audioBuffer = fileBuffer;
            } else if (file.mimetype.startsWith("video/mp4")) {
                audioBuffer = await this.extractAudioFromMP4(fileBuffer);
            } else {
                throw new Error("Unsupported audio/video format");
            }

            const transcriptionService =
                this.runtime.getService<ITranscriptionService>(
                    ServiceType.TRANSCRIPTION
                );
            if (!transcriptionService) {
                throw new Error("Transcription service not found");
            }

            const transcription =
                await transcriptionService.transcribeAttachment(audioBuffer);
            if (!transcription) {
                throw new Error("Transcription failed");
            }

            const { title, description } = await generateSummary(
                this.runtime,
                transcription
            );

            return {
                id: file.id,
                url: file.url_private,
                title: title || "Audio/Video Attachment",
                source: file.mimetype.startsWith("audio/") ? "Audio" : "Video",
                description:
                    description ||
                    "User-uploaded audio/video attachment which has been transcribed",
                text: transcription,
            };
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            console.error(
                `Error processing audio/video attachment: ${errorMessage}`
            );
            return {
                id: file.id,
                url: file.url_private,
                title: "Audio/Video Attachment",
                source: file.mimetype.startsWith("audio/") ? "Audio" : "Video",
                description: "An audio/video attachment (transcription failed)",
                text: `This is an audio/video attachment. File name: ${file.name}, Size: ${file.size} bytes, Content type: ${file.mimetype}`,
            };
        }
    }

    private async extractAudioFromMP4(mp4Data: Buffer): Promise<Buffer> {
        const tempMP4File = `temp_${Date.now()}.mp4`;
        const tempAudioFile = `temp_${Date.now()}.mp3`;

        try {
            fs.writeFileSync(tempMP4File, mp4Data);

            await new Promise<void>((resolve, reject) => {
                ffmpeg(tempMP4File)
                    .outputOptions("-vn")
                    .audioCodec("libmp3lame")
                    .save(tempAudioFile)
                    .on("end", () => resolve())
                    .on("error", (err: Error) => reject(err))
                    .run();
            });

            return fs.readFileSync(tempAudioFile);
        } finally {
            if (fs.existsSync(tempMP4File)) {
                fs.unlinkSync(tempMP4File);
            }
            if (fs.existsSync(tempAudioFile)) {
                fs.unlinkSync(tempAudioFile);
            }
        }
    }

    private async processPdfAttachment(file: SlackFile): Promise<Media> {
        try {
            const pdfBuffer = await this.fetchFileContent(file);
            const pdfService = this.runtime.getService<IPdfService>(
                ServiceType.PDF
            );

            if (!pdfService) {
                throw new Error("PDF service not found");
            }

            const text = await pdfService.convertPdfToText(pdfBuffer);
            const { title, description } = await generateSummary(
                this.runtime,
                text
            );

            return {
                id: file.id,
                url: file.url_private,
                title: title || "PDF Attachment",
                source: "PDF",
                description: description || "A PDF document",
                text: text,
            };
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            console.error(`Error processing PDF attachment: ${errorMessage}`);
            return {
                id: file.id,
                url: file.url_private,
                title: "PDF Attachment (conversion failed)",
                source: "PDF",
                description:
                    "A PDF document that could not be converted to text",
                text: `This is a PDF document. File name: ${file.name}, Size: ${file.size} bytes`,
            };
        }
    }

    private async processPlaintextAttachment(file: SlackFile): Promise<Media> {
        try {
            const textBuffer = await this.fetchFileContent(file);
            const text = textBuffer.toString("utf-8");
            const { title, description } = await generateSummary(
                this.runtime,
                text
            );

            return {
                id: file.id,
                url: file.url_private,
                title: title || "Text Attachment",
                source: "Text",
                description: description || "A text document",
                text: text,
            };
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            console.error(`Error processing text attachment: ${errorMessage}`);
            return this.processGenericAttachment(file);
        }
    }

    private async processImageAttachment(file: SlackFile): Promise<Media> {
        try {
            const imageService =
                this.runtime.getService<IImageDescriptionService>(
                    ServiceType.IMAGE_DESCRIPTION
                );
            if (!imageService) {
                throw new Error("Image description service not found");
            }

            const imageDescription =
                (await imageService.describeImage(file.url_private)) || "";
            const descriptionText =
                typeof imageDescription === "string"
                    ? imageDescription
                    : "Image description not available";

            return {
                id: file.id,
                url: file.url_private,
                title: "Image Attachment",
                source: "Image",
                description: descriptionText,
                text:
                    descriptionText ||
                    `This is an image. File name: ${file.name}, Size: ${file.size} bytes`,
            };
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            console.error(`Error processing image attachment: ${errorMessage}`);
            return this.processGenericAttachment(file);
        }
    }

    private async processVideoAttachment(file: SlackFile): Promise<Media> {
        try {
            const videoService = this.runtime.getService<IVideoService>(
                ServiceType.VIDEO
            );
            if (!videoService) {
                throw new Error("Video service not found");
            }

            // Using a more generic approach since describeVideo isn't in the interface
            const description = await this.processAudioVideoAttachment(file);
            return {
                id: file.id,
                url: file.url_private,
                title: "Video Attachment",
                source: "Video",
                description: description.text || "A video attachment",
                text:
                    description.text ||
                    `This is a video. File name: ${file.name}, Size: ${file.size} bytes`,
            };
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            console.error(`Error processing video attachment: ${errorMessage}`);
            return this.processGenericAttachment(file);
        }
    }

    private async processGenericAttachment(file: SlackFile): Promise<Media> {
        return {
            id: file.id,
            url: file.url_private,
            title: file.title || "File Attachment",
            source: "File",
            description: `A file attachment of type: ${file.mimetype}`,
            text: `This is a file attachment. File name: ${file.name}, Size: ${file.size} bytes, Type: ${file.mimetype}`,
        };
    }
}
