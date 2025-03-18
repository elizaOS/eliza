import type { UUID } from '@elizaos/core';
import { type ClassValue, clsx } from 'clsx';
import dayjs from 'dayjs';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import { twMerge } from 'tailwind-merge';

/**
 * Combines multiple class names into a single string.
 * * @param {...ClassValue} inputs - Array of class names to be combined.
 * @returns { string } - Combined class names as a single string.
 */
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
/**
 * Converts a character name to a URL-friendly format by replacing spaces with hyphens.
 *
 * @param {string} name - The name of the character to convert.
 * @returns {string} The URL-friendly version of the character name.
 */
export function characterNameToUrl(name: string): string {
  return name.replace(/\s+/g, '-');
}

/**
 * Converts a URL-friendly character name back to its original format by replacing hyphens with spaces
 */
export function urlToCharacterName(urlName: string): string {
  return urlName.replace(/-+/g, ' ');
}

// crypto.randomUUID only works in https context in firefox
export function randomUUID(): UUID {
  return URL.createObjectURL(new Blob()).split('/').pop();
}

export function getEntityId(): UUID {
  const USER_ID_KEY = 'elizaos-client-user-id';
  const existingUserId = localStorage.getItem(USER_ID_KEY);

  if (existingUserId) {
    return existingUserId as UUID;
  }

  const newUserId = randomUUID() as UUID;
  localStorage.setItem(USER_ID_KEY, newUserId);

  return newUserId;
}
