export enum TEEMode {
    OFF = "OFF",
    LOCAL = "LOCAL",           // For local development with simulator
    DOCKER = "DOCKER",         // For docker development with simulator
    PRODUCTION = "PRODUCTION"  // For production without simulator
}

export interface RemoteAttestationQuote {
    quote: string;
    timestamp: number;
}