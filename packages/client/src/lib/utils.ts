import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

dayjs.extend(localizedFormat);

export const moment = dayjs;

export const formatAgentName = (name: string) => {
	return name.substring(0, 2);
};

/**
 * Converts a character name to a URL-friendly format by replacing spaces with hyphens
 */
export function characterNameToUrl(name: string): string {
	return name.replace(/\s+/g, "-");
}

/**
 * Converts a URL-friendly character name back to its original format by replacing hyphens with spaces
 */
export function urlToCharacterName(urlName: string): string {
	return urlName.replace(/-+/g, " ");
}
