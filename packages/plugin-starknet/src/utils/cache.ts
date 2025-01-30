import NodeCache from "node-cache";
import fs from "node:fs";
import path from "node:path";

export class Cache {
    private cache: NodeCache;
    public cacheDir: string;

    constructor() {
        this.cache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache
        const __dirname = path.resolve();

        // Find the 'eliza' folder in the filepath and adjust the cache directory path
        const elizaIndex = __dirname.indexOf("eliza");
        if (elizaIndex !== -1) {
            const pathToEliza = __dirname.slice(0, elizaIndex + 5); // include 'eliza'
            this.cacheDir = path.join(pathToEliza, "cache");
        } else {
            this.cacheDir = path.join(__dirname, "cache");
        }

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir);
        }
    }

    // private readCacheFromFile<T>(cacheKey: string): T | null {
    //     const filePath = path.join(this.cacheDir, `${cacheKey}.json`);
    //     if (fs.existsSync(filePath)) {
    //         try {
    //             const fileContent = fs.readFileSync(filePath, "utf-8");
    //             const parsed = JSON.parse(fileContent);
    //             const now = Date.now();
    //             if (now < parsed.expiry) {
    //                 return parsed.data as T;
    //             } else {
    //                 fs.unlinkSync(filePath);
    //             }
    //         } catch (error) {
    //             console.error(
    //                 `Error reading cache file for key ${cacheKey}:`,
    //                 error
    //             );
    //             // Delete corrupted cache file
    //             try {
    //                 fs.unlinkSync(filePath);
    //             } catch (e) {
    //                 console.error(`Error deleting corrupted cache file:`, e);
    //             }
    //         }
    //     }
    //     return null;
    // }

    private readCacheFromFile<T>(cacheKey: string): T | null {
        const filePath = path.join(this.cacheDir, `${cacheKey}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, "utf-8");
                const parsed = JSON.parse(fileContent);
                const now = Date.now();
                if (now < parsed.expiry) {
                    return parsed.data as T;
                }
                // Fix: Remove unnecessary else clause
                fs.unlinkSync(filePath);
            } catch (error) {
                console.error(
                    `Error reading cache file for key ${cacheKey}:`,
                    error
                );
                
                // Delete corrupted cache file
                try {
                    fs.unlinkSync(filePath);
                } catch (e) {
                    console.error("Error deleting corrupted cache file:", e);
                }
            }
        }
        return null;
    }

    private writeCacheToFile<T>(cacheKey: string, data: T): void {
        try {
            const filePath = path.join(this.cacheDir, `${cacheKey}.json`);
            const cacheData = {
                data: data,
                expiry: Date.now() + 300000, // 5 minutes in milliseconds
            };
            fs.writeFileSync(filePath, JSON.stringify(cacheData), "utf-8");
        } catch (error) {
            console.error(
                `Error writing cache file for key ${cacheKey}:`,
                error
            );
        }
    }

    public get<T>(cacheKey: string): T | undefined {
        return this.cache.get<T>(cacheKey);
    }

    public set<T>(cacheKey: string, data: T): void {
        this.cache.set(cacheKey, data);
    }

    public getCachedData<T>(cacheKey: string): T | null {
        // Check in-memory cache first
        const cachedData = this.cache.get<T>(cacheKey);
        if (cachedData !== undefined) {
            return cachedData;
        }

        // Check file-based cache
        const fileCachedData = this.readCacheFromFile<T>(cacheKey);
        if (fileCachedData) {
            // Populate in-memory cache
            this.cache.set(cacheKey, fileCachedData);
            return fileCachedData;
        }

        return null;
    }

    public setCachedData<T>(cacheKey: string, data: T): void {
        // Set in-memory cache
        this.cache.set(cacheKey, data);

        // Write to file-based cache
        this.writeCacheToFile(cacheKey, data);
    }
}
