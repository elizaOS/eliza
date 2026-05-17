import { join } from "node:path";

function getCwd(): string {
	if (typeof process !== "undefined" && process.cwd) {
		return process.cwd();
	}
	return ".";
}

function getEnvVar(key: string): string | undefined {
	if (typeof process !== "undefined" && process.env) {
		return process.env[key];
	}
	return undefined;
}

export interface ElizaPathsConfig {
	dataDir: string;
	databaseDir: string;
	charactersDir: string;
	generatedDir: string;
	uploadsAgentsDir: string;
	uploadsChannelsDir: string;
}

interface PathConfig {
	envKey: string;
	subPath: string[];
}

const PATH_CONFIGS: Record<
	keyof Omit<ElizaPathsConfig, "dataDir">,
	PathConfig
> = {
	databaseDir: {
		envKey: "ELIZA_DATABASE_DIR",
		subPath: [".elizadb"],
	},
	charactersDir: {
		envKey: "ELIZA_DATA_DIR_CHARACTERS",
		subPath: ["data", "characters"],
	},
	generatedDir: {
		envKey: "ELIZA_DATA_DIR_GENERATED",
		subPath: ["data", "generated"],
	},
	uploadsAgentsDir: {
		envKey: "ELIZA_DATA_DIR_UPLOADS_AGENTS",
		subPath: ["data", "uploads", "agents"],
	},
	uploadsChannelsDir: {
		envKey: "ELIZA_DATA_DIR_UPLOADS_CHANNELS",
		subPath: ["data", "uploads", "channels"],
	},
};

class ElizaPaths {
	private cache = new Map<string, string>();

	getDataDir(): string {
		const cached = this.cache.get("dataDir");
		if (cached) return cached;

		const dir = getEnvVar("ELIZA_DATA_DIR") || join(getCwd(), ".eliza");
		this.cache.set("dataDir", dir);
		return dir;
	}

	getDatabaseDir(): string {
		return this.getPath("databaseDir", "PGLITE_DATA_DIR");
	}

	getCharactersDir(): string {
		return this.getPath("charactersDir");
	}

	getGeneratedDir(): string {
		return this.getPath("generatedDir");
	}

	getUploadsAgentsDir(): string {
		return this.getPath("uploadsAgentsDir");
	}

	getUploadsChannelsDir(): string {
		return this.getPath("uploadsChannelsDir");
	}

	getAllPaths(): ElizaPathsConfig {
		return {
			dataDir: this.getDataDir(),
			databaseDir: this.getDatabaseDir(),
			charactersDir: this.getCharactersDir(),
			generatedDir: this.getGeneratedDir(),
			uploadsAgentsDir: this.getUploadsAgentsDir(),
			uploadsChannelsDir: this.getUploadsChannelsDir(),
		};
	}

	clearCache(): void {
		this.cache.clear();
	}

	private getPath(
		key: keyof typeof PATH_CONFIGS,
		fallbackEnvKey?: string,
	): string {
		const cached = this.cache.get(key);
		if (cached) return cached;

		const config = PATH_CONFIGS[key];
		const envValue =
			getEnvVar(config.envKey) ||
			(fallbackEnvKey ? getEnvVar(fallbackEnvKey) : undefined);
		const dir = envValue || join(this.getDataDir(), ...config.subPath);

		this.cache.set(key, dir);
		return dir;
	}
}

let pathsInstance: ElizaPaths | null = null;

export function getElizaPaths(): ElizaPaths {
	if (!pathsInstance) {
		pathsInstance = new ElizaPaths();
	}
	return pathsInstance;
}

export function getDataDir(): string {
	return getElizaPaths().getDataDir();
}

export function getDatabaseDir(): string {
	return getElizaPaths().getDatabaseDir();
}

export function getCharactersDir(): string {
	return getElizaPaths().getCharactersDir();
}

export function getGeneratedDir(): string {
	return getElizaPaths().getGeneratedDir();
}

export function getUploadsAgentsDir(): string {
	return getElizaPaths().getUploadsAgentsDir();
}

export function getUploadsChannelsDir(): string {
	return getElizaPaths().getUploadsChannelsDir();
}

export function getAllElizaPaths(): ElizaPathsConfig {
	return getElizaPaths().getAllPaths();
}

export function resetPaths(): void {
	if (pathsInstance) {
		pathsInstance.clearCache();
	}
	pathsInstance = null;
}
