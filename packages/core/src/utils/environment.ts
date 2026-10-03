/** Node environment access with explicit cache invalidation after settings reload. */
import { parseBooleanValue } from "./boolean.js";

export class Environment {
	private readonly cache = new Map<string, string | undefined>();
	get(key: string, defaultValue?: string): string | undefined {
		if (!this.cache.has(key)) this.cache.set(key, process.env[key]);
		return this.cache.get(key) ?? defaultValue;
	}
	set(key: string, value: string | boolean | number): void {
		this.cache.delete(key);
		process.env[key] = String(value);
	}
	has(key: string): boolean {
		return this.get(key) !== undefined;
	}
	getAll(): Record<string, string | undefined> {
		return { ...process.env };
	}
	getBoolean(key: string, defaultValue = false): boolean {
		return parseBooleanValue(this.get(key)) ?? defaultValue;
	}
	getNumber(key: string, defaultValue?: number): number | undefined {
		const value = this.get(key)?.trim();
		if (!value) return defaultValue;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : defaultValue;
	}
	clearCache(): void {
		this.cache.clear();
	}
}
const environment = new Environment();
export function getEnvironment(): Environment {
	return environment;
}
export function getEnv(key: string, defaultValue?: string): string | undefined {
	return environment.get(key, defaultValue);
}
export function setEnv(key: string, value: string | boolean | number): void {
	environment.set(key, value);
}
export function hasEnv(key: string): boolean {
	return environment.has(key);
}
export function getBooleanEnv(key: string, defaultValue = false): boolean {
	return environment.getBoolean(key, defaultValue);
}
export function getNumberEnv(
	key: string,
	defaultValue?: number,
): number | undefined {
	return environment.getNumber(key, defaultValue);
}
