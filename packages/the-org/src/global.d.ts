/// <reference types="node" />

declare module 'fs' {
    export function readFileSync(path: string, options?: { encoding?: string; flag?: string } | string): string | Buffer;
    export function writeFileSync(path: string, data: string | Buffer, options?: { encoding?: string; flag?: string } | string): void;
    export function existsSync(path: string): boolean;
    export function readdirSync(path: string, options?: { encoding?: string; withFileTypes?: boolean }): string[] | fs.Dirent[];
    export function readFileSync(path: string): Buffer;
    export function toString(encoding: string): string;
}

declare module 'path' {
    export function resolve(...paths: string[]): string;
    export function join(...paths: string[]): string;
}

declare module 'dotenv' {
    export function config(options?: { path?: string; encoding?: string; debug?: boolean; override?: boolean }): { parsed: { [key: string]: string } };
}

declare namespace NodeJS {
    interface ProcessEnv {
        [key: string]: string | undefined;
        INVESTMENT_MANAGER_DISCORD_APPLICATION_ID?: string;
        INVESTMENT_MANAGER_DISCORD_API_TOKEN?: string;
    }

    interface Process {
        env: ProcessEnv;
    }
}

declare var process: NodeJS.Process; 