import { Content } from "@elizaos/core";
import type { ChatCompletion } from "openai/resources/chat/completions";

export interface BoundingBox {
    vertices: {
        x: number;
        y: number;
    }[];
    bbox_confidence: number;
    is_deepfake: number;
}

export interface DeepFakeAnalysis {
    index: number;
    bounding_boxes: BoundingBox[];
    image?: string;  // base64 encoded image with bounding boxes
    status: "SUCCESS" | "FAILURE";
}

export type DeepFakeResponse = {
    data: DeepFakeAnalysis[];
};

export interface DeepFakeContent extends Content {
    text: string;
    mediaPath: string;
    success?: boolean;
    data?: {
        response?: string;
        analysis?: DeepFakeAnalysis[];
        error?: string;
        raw?: DeepFakeResponse;
        processedImage?: string;  // base64 of the processed image with bounding boxes
    };
}