export interface UdioSamplerOptions {
    seed: number;
    audio_conditioning_path?: string;
    audio_conditioning_song_id?: string;
    audio_conditioning_type?: 'continuation';
    crop_start_time?: number;
}

export interface UdioGenerateOptions {
    prompt: string;
    seed?: number;
    customLyrics?: string;
}

export interface UdioExtendOptions extends UdioGenerateOptions {
    audioConditioningPath: string;
    audioConditioningSongId: string;
    cropStartTime?: number;
}

export interface UdioSong {
    id: string;
    title: string;
    song_path: string;
    finished: boolean;
}

export interface UdioResponse {
    songs: UdioSong[];
}

export interface UdioGenerateResponse {
    track_ids: string[];
}