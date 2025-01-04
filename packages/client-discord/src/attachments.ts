import { generateText, trimTokens } from "@elizaos/core";
import { parseJSONObjectFromText } from "@elizaos/core";
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
import { Attachment, Collection } from "discord.js";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

async function generateSummary(
    runtime: IAgentRuntime,
    text: string
): Promise<{ title: string; description: string }> {
    // make sure text is under 128k characters
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

export class AttachmentManager {
    private attachmentCache: Map<string, Media> = new Map();
    private runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }

    async processAttachments(
        attachments: Collection<string, Attachment> | Attachment[]
    ): Promise<Media[]> {
        const processedAttachments: Media[] = [];
        const attachmentCollection =
            attachments instanceof Collection
                ? attachments
                : new Collection(attachments.map((att) => [att.id, att]));

        for (const [, attachment] of attachmentCollection) {
            const media = await this.processAttachment(attachment);
            if (media) {
                processedAttachments.push(media);
            }
        }

        return processedAttachments;
    }

    async processAttachment(attachment: Attachment): Promise<Media | null> {
        if (this.attachmentCache.has(attachment.url)) {
            return this.attachmentCache.get(attachment.url)!;
        }

        let media: Media | null = null;
        if (attachment.contentType?.startsWith("application/pdf")) {
            media = await this.processPdfAttachment(attachment);
        } else if (attachment.contentType?.startsWith("text/plain")) {
            media = await this.processPlaintextAttachment(attachment);
        } else if (
            attachment.contentType?.startsWith("audio/") ||
            attachment.contentType?.startsWith("video/mp4")
        ) {
            media = await this.processAudioVideoAttachment(attachment);
        } else if (attachment.contentType?.startsWith("image/")) {
            media = await this.processImageAttachment(attachment);
        } else if (
            attachment.contentType?.startsWith("video/") ||
            this.runtime
                .getService<IVideoService>(ServiceType.VIDEO)
                .isVideoUrl(attachment.url)
        ) {
            media = await this.processVideoAttachment(attachment);
        } else {
            media = await this.processGenericAttachment(attachment);
        }

        if (media) {
            this.attachmentCache.set(attachment.url, media);
        }
        return media;
    }

    private async processAudioVideoAttachment(
        attachment: Attachment
    ): Promise<Media> {
        try {
            const response = await fetch(attachment.url);
            const audioVideoArrayBuffer = await response.arrayBuffer();

            let audioBuffer: Buffer;
            if (attachment.contentType?.startsWith("audio/")) {
                audioBuffer = Buffer.from(audioVideoArrayBuffer);
            } else if (attachment.contentType?.startsWith("video/mp4")) {
                audioBuffer = await this.extractAudioFromMP4(
                    audioVideoArrayBuffer
                );
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
            const { title, description } = await generateSummary(
                this.runtime,
                transcription
            );

            return {
                id: attachment.id,
                url: attachment.url,
                title: title || "Audio/Video Attachment",
                source: attachment.contentType?.startsWith("audio/")
                    ? "Audio"
                    : "Video",
                description:
                    description ||
                    "User-uploaded audio/video attachment which has been transcribed",
                text: transcription || "Audio/video content not available",
            };
        } catch (error) {
            console.error(
                `Error processing audio/video attachment: ${error.message}`
            );
            return {
                id: attachment.id,
                url: attachment.url,
                title: "Audio/Video Attachment",
                source: attachment.contentType?.startsWith("audio/")
                    ? "Audio"
                    : "Video",
                description: "An audio/video attachment (transcription failed)",
                text: `This is an audio/video attachment. File name: ${attachment.name}, Size: ${attachment.size} bytes, Content type: ${attachment.contentType}`,
            };
        }
    }

    private async extractAudioFromMP4(mp4Data: ArrayBuffer): Promise<Buffer> {
        // Use a library like 'fluent-ffmpeg' or 'ffmpeg-static' to extract the audio stream from the MP4 data
        // and convert it to MP3 or WAV format
        // Example using fluent-ffmpeg:
        const tempMP4File = `temp_${Date.now()}.mp4`;
        const tempAudioFile = `temp_${Date.now()}.mp3`;

        try {
            // Write the MP4 data to a temporary file
            fs.writeFileSync(tempMP4File, Buffer.from(mp4Data));

            // Extract the audio stream and convert it to MP3
            await new Promise<void>((resolve, reject) => {
                ffmpeg(tempMP4File)
                    .outputOptions("-vn") // Disable video output
                    .audioCodec("libmp3lame") // Set audio codec to MP3
                    .save(tempAudioFile) // Save the output to the specified file
                    .on("end", () => {
                        resolve();
                    })
                    .on("error", (err) => {
                        reject(err);
                    })
                    .run();
            });

            // Read the converted audio file and return it as a Buffer
            const audioData = fs.readFileSync(tempAudioFile);
            return audioData;
        } finally {
            // Clean up the temporary files
            if (fs.existsSync(tempMP4File)) {
                fs.unlinkSync(tempMP4File);
            }
            if (fs.existsSync(tempAudioFile)) {
                fs.unlinkSync(tempAudioFile);
            }
        }
    }

    private async processPdfAttachment(attachment: Attachment): Promise<Media> {
        try {
            const response = await fetch(attachment.url);
            const pdfBuffer = await response.arrayBuffer();
            const text = await this.runtime
                .getService<IPdfService>(ServiceType.PDF)
                .convertPdfToText(Buffer.from(pdfBuffer));
            const { title, description } = await generateSummary(
                this.runtime,
                text
            );

            return {
                id: attachment.id,
                url: attachment.url,
                title: title || "PDF Attachment",
                source: "PDF",
                description: description || "A PDF document",
                text: text,
            };
        } catch (error) {
            console.error(`Error processing PDF attachment: ${error.message}`);
            return {
                id: attachment.id,
                url: attachment.url,
                title: "PDF Attachment (conversion failed)",
                source: "PDF",
                description:
                    "A PDF document that could not be converted to text",
                text: `This is a PDF attachment. File name: ${attachment.name}, Size: ${attachment.size} bytes`,
            };
        }
    }

    private async processPlaintextAttachment(
        attachment: Attachment
    ): Promise<Media> {
        try {
            const response = await fetch(attachment.url);
            const text = await response.text();
            const { title, description } = await generateSummary(
                this.runtime,
                text
            );

            return {
                id: attachment.id,
                url: attachment.url,
                title: title || "Plaintext Attachment",
                source: "Plaintext",
                description: description || "A plaintext document",
                text: text,
            };
        } catch (error) {
            console.error(
                `Error processing plaintext attachment: ${error.message}`
            );
            return {
                id: attachment.id,
                url: attachment.url,
                title: "Plaintext Attachment (retrieval failed)",
                source: "Plaintext",
                description: "A plaintext document that could not be retrieved",
                text: `This is a plaintext attachment. File name: ${attachment.name}, Size: ${attachment.size} bytes`,
            };
        }
    }

    private async processImageAttachment(
        attachment: Attachment
    ): Promise<Media> {
        try {
            const { description, title } = await this.runtime
                .getService<IImageDescriptionService>(
                    ServiceType.IMAGE_DESCRIPTION
                )
                .describeImage(attachment.url);
            return {
                id: attachment.id,
                url: attachment.url,
                title: title || "Image Attachment",
                source: "Image",
                description: description || "An image attachment",
                text: description || "Image content not available",
            };
        } catch (error) {
            console.error(
                `Error processing image attachment: ${error.message}`
            );
            return this.createFallbackImageMedia(attachment);
        }
    }

    private createFallbackImageMedia(attachment: Attachment): Media {
        return {
            id: attachment.id,
            url: attachment.url,
            title: "Image Attachment",
            source: "Image",
            description: "An image attachment (recognition failed)",
            text: `This is an image attachment. File name: ${attachment.name}, Size: ${attachment.size} bytes, Content type: ${attachment.contentType}`,
        };
    }

    private async processVideoAttachment(
        attachment: Attachment
    ): Promise<Media> {
        const videoService = this.runtime.getService<IVideoService>(
            ServiceType.VIDEO
        );

        if (!videoService) {
            throw new Error("Video service not found");
        }

        if (videoService.isVideoUrl(attachment.url)) {
            const videoInfo = await videoService.processVideo(
                attachment.url,
                this.runtime
            );
            return {
                id: attachment.id,
                url: attachment.url,
                title: videoInfo.title,
                source: "YouTube",
                description: videoInfo.description,
                text: videoInfo.text,
            };
        } else {
            return {
                id: attachment.id,
                url: attachment.url,
                title: "Video Attachment",
                source: "Video",
                description: "A video attachment",
                text: "Video content not available",
            };
        }
    }

    private async processGenericAttachment(
        attachment: Attachment
    ): Promise<Media> {
        return {
            id: attachment.id,
            url: attachment.url,
            title: "Generic Attachment",
            source: "Generic",
            description: "A generic attachment",
            text: "Attachment content not available",
        };
    }
}
