export interface GenerateParams {
    prompt: string;
    duration?: number;
    temperature?: number;
    topK?: number;
    topP?: number;
    classifier_free_guidance?: number;
}

export interface CustomGenerateParams {
    prompt: string;
    duration?: number;
    temperature?: number;
    topK?: number;
    topP?: number;
    classifier_free_guidance?: number;
    reference_audio?: string;
    style?: string;
    bpm?: number;
    key?: string;
    mode?: string;
}

export interface ExtendParams {
    audio_id: string;
    duration: number;
}

export interface GenerationResponse {
    id: string;
    status: string;
    url?: string;
    error?: string;
}