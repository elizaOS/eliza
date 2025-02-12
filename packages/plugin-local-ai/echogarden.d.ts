declare module "echogarden" {
    interface SynthesizeOptions {
        engine: string;
        voice: string;
    }

    interface RawAudio {
        audioChannels: { buffer: ArrayBuffer }[];
        sampleRate: number;
    }

    interface SynthesizeResult {
        audio: Buffer | RawAudio;
    }

    export function synthesize(
        text: string,
        options: SynthesizeOptions
    ): Promise<SynthesizeResult>;
}
