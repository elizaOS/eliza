import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type IAgentRuntime,
  type Media,
  ModelType,
  type Service,
  ServiceType,
} from "@elizaos/core";
import { type Attachment, Collection } from "discord.js";
import ffmpeg from "fluent-ffmpeg";
import { generateSummary } from "./utils";

/**
 * Class representing an Attachment Manager.
 */
export class AttachmentManager {
  private attachmentCache: Map<string, Media> = new Map();
  private runtime: IAgentRuntime;

  /**
   * Constructor for creating a new instance of the class.
   *
   * @param {IAgentRuntime} runtime The runtime object to be injected into the instance.
   */
  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Processes attachments and returns an array of Media objects.
   * @param {Collection<string, Attachment> | Attachment[]} attachments - The attachments to be processed
   * @returns {Promise<Media[]>} - An array of processed Media objects
   */
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

  /**
   * Processes the provided attachment to generate a media object.
   * If the media for the attachment URL is already cached, it will return the cached media.
   * Otherwise, it will determine the type of attachment (PDF, text, audio, video, image, generic)
   * and call the corresponding processing method to generate the media object.
   *
   * @param attachment The attachment to process
   * @returns A promise that resolves to a Media object representing the attachment, or null if the attachment could not be processed
   */
  async processAttachment(attachment: Attachment): Promise<Media | null> {
    const cached = this.attachmentCache.get(attachment.url);
    if (cached) {
      return cached;
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
    } else if (attachment.contentType?.startsWith("video/")) {
      media = await this.processVideoAttachment(attachment);
    } else {
      const videoService = this.runtime.getService(ServiceType.VIDEO) as
        | ({ isVideoUrl?: (url: string) => boolean } & Service)
        | null;
      if (videoService?.isVideoUrl?.(attachment.url)) {
        media = await this.processVideoAttachment(attachment);
      } else {
        media = await this.processGenericAttachment(attachment);
      }
    }

    if (media) {
      this.attachmentCache.set(attachment.url, media);
    }
    return media;
  }

  /**
   * Asynchronously processes an audio or video attachment provided as input and returns a Media object.
   * @param {Attachment} attachment - The attachment object containing information about the audio/video file.
   * @returns {Promise<Media>} A Promise that resolves to a Media object representing the processed audio/video attachment.
   */
  private async processAudioVideoAttachment(attachment: Attachment): Promise<Media> {
    try {
      const response = await fetch(attachment.url);
      const audioVideoArrayBuffer = await response.arrayBuffer();

      let audioBuffer: Buffer;
      let audioFileName: string;
      let audioMimeType: string;

      if (attachment.contentType?.startsWith("audio/")) {
        audioBuffer = Buffer.from(audioVideoArrayBuffer);
        audioFileName = attachment.name || "audio.mp3";
        audioMimeType = attachment.contentType;
      } else if (attachment.contentType?.startsWith("video/mp4")) {
        audioBuffer = await this.extractAudioFromMP4(audioVideoArrayBuffer);
        audioFileName = "extracted_audio.mp3";
        audioMimeType = "audio/mpeg";
      } else {
        throw new Error("Unsupported audio/video format");
      }

      // Convert Buffer to File object for transcription API
      const audioBlob = new Blob([new Uint8Array(audioBuffer)], {
        type: audioMimeType,
      });
      const audioFile = new File([audioBlob], audioFileName, {
        type: audioMimeType,
      });

      // Convert File to Buffer for transcription
      const transcriptionBuffer = Buffer.from(await audioFile.arrayBuffer());
      const transcription = await this.runtime.useModel(
        ModelType.TRANSCRIPTION,
        transcriptionBuffer
      );

      // Assess transcription length before summarizing
      const transcriptionLength = transcription?.length || 0;
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          attachmentId: attachment.id,
          contentType: attachment.contentType,
          transcriptionLength,
        },
        "Assessing transcription length before summarization"
      );

      // Only summarize if transcription is meaningful (not empty and long enough)
      let title: string | undefined;
      let description: string | undefined;

      if (!transcription || transcriptionLength === 0) {
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            attachmentId: attachment.id,
          },
          "Transcription is empty, skipping summarization"
        );
        title = undefined;
        description = "User-uploaded audio/video attachment (no transcription available)";
      } else if (transcriptionLength < 1000) {
        // Short transcriptions don't benefit from summarization
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            attachmentId: attachment.id,
            transcriptionLength,
          },
          "Transcription is short, skipping summarization"
        );
        title = undefined;
        description = transcription;
      } else {
        // Transcription is long enough to benefit from summarization
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            attachmentId: attachment.id,
            transcriptionLength,
          },
          "Summarizing transcription"
        );
        const summary = await generateSummary(this.runtime, transcription);
        title = summary.title;
        description = summary.description;
      }

      return {
        id: attachment.id,
        url: attachment.url,
        title: title || "Audio/Video Attachment",
        source: attachment.contentType?.startsWith("audio/") ? "Audio" : "Video",
        description:
          description || "User-uploaded audio/video attachment which has been transcribed",
        text: transcription || "Audio/video content not available",
      };
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          attachmentId: attachment.id,
          contentType: attachment.contentType,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing audio/video attachment"
      );

      return {
        id: attachment.id,
        url: attachment.url,
        title: "Audio/Video Attachment",
        source: attachment.contentType?.startsWith("audio/") ? "Audio" : "Video",
        description: "An audio/video attachment (transcription failed)",
        text: `This is an audio/video attachment. File name: ${attachment.name}, Size: ${attachment.size} bytes, Content type: ${attachment.contentType}`,
      };
    }
  }

  /**
   * Extracts the audio stream from the provided MP4 data and converts it to MP3 format.
   *
   * @param {ArrayBuffer} mp4Data - The MP4 data to extract audio from
   * @returns {Promise<Buffer>} - A Promise that resolves with the converted audio data as a Buffer
   */
  private async extractAudioFromMP4(mp4Data: ArrayBuffer): Promise<Buffer> {
    // Use fluent-ffmpeg to extract the audio stream from the MP4 data
    // and convert it to MP3 format
    const tmpDir = os.tmpdir();
    const timestamp = Date.now();
    const tempMP4File = path.join(tmpDir, `discord_video_${timestamp}.mp4`);
    const tempAudioFile = path.join(tmpDir, `discord_audio_${timestamp}.mp3`);

    try {
      // Write the MP4 data to a temporary file
      fs.writeFileSync(tempMP4File, Buffer.from(mp4Data));

      // Check if file has audio stream using ffprobe
      await new Promise<void>((resolve, reject) => {
        ffmpeg.ffprobe(tempMP4File, (err, metadata) => {
          if (err) {
            reject(err);
            return;
          }

          if (!metadata.streams || !Array.isArray(metadata.streams)) {
            reject(new Error("File metadata does not contain valid streams information"));
            return;
          }

          const hasAudio = metadata.streams.some((stream) => stream.codec_type === "audio");
          if (!hasAudio) {
            reject(new Error("File does not contain any audio streams"));
            return;
          }
          resolve();
        });
      });

      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          tempMP4File,
          tempAudioFile,
        },
        "Extracting audio from MP4"
      );

      // Extract the audio stream and convert it to MP3
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tempMP4File)
          .noVideo() // Disable video output
          .audioCodec("libmp3lame") // Set audio codec to MP3
          .toFormat("mp3") // Explicitly set output format
          .on("end", () => {
            resolve();
          })
          .on("error", (err) => {
            reject(err);
          })
          .output(tempAudioFile)
          .run();
      });

      // Read the converted audio file and return it as a Buffer
      const audioData = fs.readFileSync(tempAudioFile);

      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          audioDataSize: audioData.length,
        },
        "Successfully extracted audio from MP4"
      );

      return audioData;
    } finally {
      // Clean up the temporary files
      try {
        if (fs.existsSync(tempMP4File)) {
          fs.unlinkSync(tempMP4File);
        }
        if (fs.existsSync(tempAudioFile)) {
          fs.unlinkSync(tempAudioFile);
        }
      } catch (cleanupError) {
        this.runtime.logger.warn(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
          "Failed to cleanup temp files"
        );
      }
    }
  }

  /**
   * Processes a PDF attachment by fetching the PDF file from the specified URL,
   * converting it to text, generating a summary, and returning a Media object
   * with the extracted information.
   * If an error occurs during processing, a placeholder Media object is returned
   * with an error message.
   *
   * @param {Attachment} attachment - The PDF attachment to process.
   * @returns {Promise<Media>} A promise that resolves to a Media object representing
   * the processed PDF attachment.
   */
  private async processPdfAttachment(attachment: Attachment): Promise<Media> {
    try {
      const response = await fetch(attachment.url);
      const pdfBuffer = await response.arrayBuffer();
      const pdfService = this.runtime.getService(ServiceType.PDF) as
        | ({ convertPdfToText: (buffer: Buffer) => Promise<string> } & Service)
        | null;
      if (!pdfService) {
        throw new Error("PDF service not found");
      }
      const text = await pdfService.convertPdfToText(Buffer.from(pdfBuffer));
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          attachmentId: attachment.id,
          textLength: text?.length,
        },
        "Summarizing PDF content"
      );
      const { title, description } = await generateSummary(this.runtime, text);

      return {
        id: attachment.id,
        url: attachment.url,
        title: title || "PDF Attachment",
        source: "PDF",
        description: description || "A PDF document",
        text,
      };
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          attachmentId: attachment.id,
          contentType: attachment.contentType,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing PDF attachment"
      );

      return {
        id: attachment.id,
        url: attachment.url,
        title: "PDF Attachment (conversion failed)",
        source: "PDF",
        description: "A PDF document that could not be converted to text",
        text: `This is a PDF attachment. File name: ${attachment.name}, Size: ${attachment.size} bytes`,
      };
    }
  }

  /**
   * Processes a plaintext attachment by fetching its content, generating a summary, and returning a Media object.
   * @param {Attachment} attachment - The attachment object to process.
   * @returns {Promise<Media>} A promise that resolves to a Media object representing the processed plaintext attachment.
   */
  private async processPlaintextAttachment(attachment: Attachment): Promise<Media> {
    try {
      const response = await fetch(attachment.url);
      const text = await response.text();
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          attachmentId: attachment.id,
          textLength: text?.length,
        },
        "Summarizing plaintext content"
      );
      const { title, description } = await generateSummary(this.runtime, text);

      return {
        id: attachment.id,
        url: attachment.url,
        title: title || "Plaintext Attachment",
        source: "Plaintext",
        description: description || "A plaintext document",
        text,
      };
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          attachmentId: attachment.id,
          contentType: attachment.contentType,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing plaintext attachment"
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

  /**
   * Process the image attachment by fetching description and title using the IMAGE_DESCRIPTION model.
   * If successful, returns a Media object populated with the details. If unsuccessful, creates a fallback
   * Media object and logs the error.
   *
   * @param {Attachment} attachment - The attachment object containing the image details.
   * @returns {Promise<Media>} A promise that resolves to a Media object.
   */
  private async processImageAttachment(attachment: Attachment): Promise<Media> {
    try {
      const { description, title } = await this.runtime.useModel(
        ModelType.IMAGE_DESCRIPTION,
        attachment.url
      );
      return {
        id: attachment.id,
        url: attachment.url,
        title: title || "Image Attachment",
        source: "Image",
        description: description || "An image attachment",
        text: description || "Image content not available",
      };
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          attachmentId: attachment.id,
          contentType: attachment.contentType,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error processing image attachment"
      );

      return this.createFallbackImageMedia(attachment);
    }
  }

  /**
   * Creates a fallback Media object for image attachments that could not be recognized.
   *
   * @param {Attachment} attachment - The attachment object containing image details.
   * @returns {Media} - The fallback Media object with basic information about the image attachment.
   */

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

  /**
   * Process a video attachment to extract video information.
   * @param {Attachment} attachment - The attachment object containing video information.
   * @returns {Promise<Media>} A promise that resolves to a Media object with video details.
   * @throws {Error} If video service is not available.
   */
  private async processVideoAttachment(attachment: Attachment): Promise<Media> {
    const videoService = this.runtime.getService(ServiceType.VIDEO) as
      | ({
          isVideoUrl?: (url: string) => boolean;
          processVideo?: (
            url: string,
            runtime: IAgentRuntime
          ) => Promise<{
            title: string;
            description: string;
            text: string;
          }>;
        } & Service)
      | null;

    if (!videoService) {
      return {
        id: attachment.id,
        url: attachment.url,
        title: "Video Attachment (Service Unavailable)",
        source: "Video",
        description:
          "Could not process video attachment because the required service is not available.",
        text: "Video content not available",
      };
    }

    if (typeof videoService.isVideoUrl === "function" && videoService.isVideoUrl(attachment.url)) {
      const videoInfo = await videoService.processVideo(attachment.url, this.runtime);
      return {
        id: attachment.id,
        url: attachment.url,
        title: videoInfo.title,
        source: "YouTube",
        description: videoInfo.description,
        text: videoInfo.text,
      };
    }
    return {
      id: attachment.id,
      url: attachment.url,
      title: "Video Attachment",
      source: "Video",
      description: "A video attachment",
      text: "Video content not available",
    };
  }

  /**
   * Process a generic attachment and return a Media object with specified properties.
   * @param {Attachment} attachment - The attachment object to process.
   * @returns {Promise<Media>} A Promise that resolves to a Media object with specified properties.
   */
  private async processGenericAttachment(attachment: Attachment): Promise<Media> {
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
