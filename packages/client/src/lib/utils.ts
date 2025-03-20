import { AVATAR_IMAGE_MAX_SIZE } from '@/constants';
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
  return URL.createObjectURL(new Blob()).split('/').pop() as UUID;
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

export const compressImage = (
  file: File,
  maxSize = AVATAR_IMAGE_MAX_SIZE,
  quality = 0.8
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        const img = new Image();
        img.src = e.target.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > maxSize) {
              height *= maxSize / width;
              width = maxSize;
            }
          } else {
            if (height > maxSize) {
              width *= maxSize / height;
              height = maxSize;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          const resizedBase64 = canvas.toDataURL('image/jpeg', quality);

          resolve(resizedBase64);
        };
        img.onerror = reject;
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

/**
 * Deeply merges multiple objects together
 * - Arrays are completely replaced (not merged)
 * - Null values explicitly overwrite existing values
 * - Undefined values are ignored (don't overwrite)
 *
 * @param target The base object to merge into
 * @param sources One or more source objects to merge from
 * @returns A new merged object
 */
export function deepMerge<T>(target: T, ...sources: Partial<T>[]): T {
  if (!sources.length) return target;

  const result = { ...target };

  sources.forEach((source) => {
    if (!source) return;

    Object.keys(source).forEach((key) => {
      const sourceValue = source[key as keyof typeof source];

      // Skip undefined values - they shouldn't overwrite existing values
      if (sourceValue === undefined) return;

      // Handle null values - they should explicitly overwrite
      if (sourceValue === null) {
        result[key as keyof T] = null as any;
        return;
      }

      // For arrays, completely replace them
      if (Array.isArray(sourceValue)) {
        result[key as keyof T] = [...sourceValue] as any;
        return;
      }

      // For objects, recursively merge
      if (
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        sourceValue !== null &&
        typeof result[key as keyof T] === 'object' &&
        result[key as keyof T] !== null &&
        !Array.isArray(result[key as keyof T])
      ) {
        result[key as keyof T] = deepMerge(result[key as keyof T] as any, sourceValue as any);
        return;
      }

      // For all other values, just replace them
      result[key as keyof T] = sourceValue as any;
    });
  });

  return result;
}
