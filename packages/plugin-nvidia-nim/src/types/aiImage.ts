import { Content } from "@elizaos/core";

export interface AIImageSource {
    sora: number;
    pika: number;
    haiper: number;
    kling: number;
    luma: number;
    hedra: number;
    runway: number;
    flux: number;
    sdxlinpaint: number;
    stablediffusioninpaint: number;
    otherimagegenerators: number;
    bingimagecreator: number;
    adobefirefly: number;
    lcm: number;
    dalle: number;
    pixart: number;
    glide: number;
    stablediffusion: number;
    imagen: number;
    amused: number;
    stablecascade: number;
    midjourney: number;
    deepfloyd: number;
    gan: number;
    stablediffusionxl: number;
    vqdiffusion: number;
    kandinsky: number;
    wuerstchen: number;
    titan: number;
    ideogram: number;
    none: number;
}

export interface AIImageAnalysis {
    index: number;
    is_ai_generated: number;
    possible_sources: AIImageSource;
    status: "SUCCESS" | "FAILURE";
}

export type AIImageResponse = {
    data: AIImageAnalysis[];
};

export interface AIImageContent extends Content {
    text: string;
    mediaPath: string;
    success?: boolean;
    data?: {
        response?: string;
        analysis?: AIImageAnalysis[];
        error?: string;
        raw?: AIImageResponse;
    };
}