/**
 * Character Mapping Service
 *
 * Handles find/replace of real names with parody names in text.
 * Uses StaticDataRegistry for mappings (no database calls).
 */

import { logger } from "@feed/shared";
import {
  type CharacterMapping,
  type OrganizationMapping,
  StaticDataRegistry,
} from "./static-data-registry";

export interface TextReplacementResult {
  transformedText: string;
  characterMappings: Record<string, string>; // real -> parody
  organizationMappings: Record<string, string>; // real -> parody
  replacementCount: number;
}

interface ActiveCharacterMapping extends CharacterMapping {
  isActive: boolean;
}

interface ActiveOrganizationMapping extends OrganizationMapping {
  isActive: boolean;
}

export class CharacterMappingService {
  private characterMappingsCache: ActiveCharacterMapping[] = [];
  private organizationMappingsCache: ActiveOrganizationMapping[] = [];
  private initialized = false;

  private loadMappings(): void {
    if (this.initialized) {
      return;
    }

    const charMappings = StaticDataRegistry.getAllCharacterMappings();
    const orgMappings = StaticDataRegistry.getAllOrganizationMappings();

    this.characterMappingsCache = charMappings
      .map((m) => ({ ...m, isActive: true }))
      .sort((a, b) => b.priority - a.priority);

    this.organizationMappingsCache = orgMappings
      .map((m) => ({ ...m, isActive: true }))
      .sort((a, b) => b.priority - a.priority);

    this.initialized = true;
    logger.info(
      `Loaded ${this.characterMappingsCache.length} character and ${this.organizationMappingsCache.length} organization mappings`,
      undefined,
      "CharacterMappingService",
    );
  }

  /** Build word-to-word mapping from real name to parody name */
  private buildWordMapping(
    realName: string,
    parodyName: string,
  ): Map<string, string> {
    const realWords = realName.split(/\s+/);
    const parodyWords = parodyName.split(/\s+/);
    const wordMap = new Map<string, string>();

    // Map corresponding words by position
    for (let i = 0; i < realWords.length && i < parodyWords.length; i++) {
      const realWord = realWords[i];
      const parodyWord = parodyWords[i];
      if (realWord && parodyWord) {
        wordMap.set(realWord.toLowerCase(), parodyWord);
      }
    }

    return wordMap;
  }

  /**
   * Preserve case pattern: lowercase→lowercase, UPPERCASE→UPPERCASE.
   * Mixed case keeps parody's original casing to preserve AI-pun styling.
   */
  private preserveCase(original: string, replacement: string): string {
    if (!original || !replacement) return replacement;

    // Check if original is all lowercase → lowercase output
    if (original === original.toLowerCase()) {
      return replacement.toLowerCase();
    }

    // Check if original is all uppercase → uppercase output
    if (original === original.toUpperCase()) {
      return replacement.toUpperCase();
    }

    return replacement;
  }

  private generateUsername(name: string): string {
    return name.toLowerCase().replace(/\s+/g, "");
  }

  /** Get replacement for search term - full name or word-to-word mapped alias */
  private getReplacementForTerm(
    searchName: string,
    realName: string,
    parodyName: string,
  ): string {
    // If searching for the full name, return full parody name
    if (searchName.toLowerCase() === realName.toLowerCase()) {
      return parodyName;
    }

    // Build word mapping and look for the search term
    const wordMap = this.buildWordMapping(realName, parodyName);
    const searchLower = searchName.toLowerCase();

    // Check if searchName is a single word that maps
    if (wordMap.has(searchLower)) {
      return wordMap.get(searchLower)!;
    }

    // For multi-word aliases, try to map each word
    const searchWords = searchName.split(/\s+/);
    if (searchWords.length > 1) {
      const mappedWords = searchWords.map((word) => {
        const mapped = wordMap.get(word.toLowerCase());
        return mapped || word; // Keep original if no mapping
      });
      return mappedWords.join(" ");
    }

    return parodyName;
  }

  /** Transform text by replacing real names with parody equivalents */
  async transformText(text: string): Promise<TextReplacementResult> {
    this.loadMappings();

    let transformedText = text;
    const characterMappingsResult: Record<string, string> = {};
    const organizationMappingsResult: Record<string, string> = {};
    let replacementCount = 0;

    // Phase 1: Replace @usernames first to avoid partial matches
    for (const mapping of this.characterMappingsCache) {
      const realUsername = this.generateUsername(mapping.realName);
      const parodyUsername = this.generateUsername(mapping.parodyName);

      if (realUsername === parodyUsername) continue;
      if (transformedText.toLowerCase().includes(parodyUsername)) continue;

      const usernameRegex = new RegExp(
        `@${escapeRegex(realUsername)}\\b`,
        "gi",
      );

      if (usernameRegex.test(transformedText)) {
        transformedText = transformedText.replace(usernameRegex, (match) => {
          const matchedUsername = match.slice(1);
          const casedReplacement = this.preserveCase(
            matchedUsername,
            parodyUsername,
          );
          characterMappingsResult[`@${realUsername}`] = `@${casedReplacement}`;
          replacementCount++;
          return `@${casedReplacement}`;
        });
      }
    }

    // Phase 2: Replace character names
    for (const mapping of this.characterMappingsCache) {
      const searchNames = [mapping.realName, ...mapping.aliases];

      for (const searchName of searchNames) {
        const replacement = this.getReplacementForTerm(
          searchName,
          mapping.realName,
          mapping.parodyName,
        );

        if (transformedText.toLowerCase().includes(replacement.toLowerCase())) {
          continue;
        }

        const regex = new RegExp(
          `(?:^|\\s|[^a-zA-Z@])${escapeRegex(searchName)}(?:$|\\s|[^a-zA-Z])`,
          "gi",
        );

        const matches = transformedText.match(regex);
        if (matches) {
          transformedText = transformedText.replace(regex, (match) => {
            const matchLower = match.toLowerCase();
            const searchLower = searchName.toLowerCase();

            const leadingChar = !matchLower.startsWith(searchLower[0] ?? "")
              ? match[0]
              : "";
            const trailingChar = !matchLower.endsWith(
              searchLower[searchLower.length - 1] ?? "",
            )
              ? match[match.length - 1]
              : "";

            const actualMatch = match.slice(
              leadingChar ? 1 : 0,
              trailingChar ? -1 : undefined,
            );

            const casedReplacement = this.preserveCase(
              actualMatch,
              replacement,
            );

            characterMappingsResult[searchName] = casedReplacement;
            replacementCount++;

            return `${leadingChar}${casedReplacement}${trailingChar}`;
          });
        }
      }
    }

    // Phase 3: Replace organization names
    for (const mapping of this.organizationMappingsCache) {
      const searchNames = [mapping.realName, ...mapping.aliases];

      for (const searchName of searchNames) {
        const replacement = this.getReplacementForTerm(
          searchName,
          mapping.realName,
          mapping.parodyName,
        );

        if (transformedText.toLowerCase().includes(replacement.toLowerCase())) {
          continue;
        }

        const regex = new RegExp(
          `(?:^|\\s|[^a-zA-Z@])${escapeRegex(searchName)}(?:$|\\s|[^a-zA-Z])`,
          "gi",
        );

        const matches = transformedText.match(regex);
        if (matches) {
          transformedText = transformedText.replace(regex, (match) => {
            const matchLower = match.toLowerCase();
            const searchLower = searchName.toLowerCase();

            const leadingChar = !matchLower.startsWith(searchLower[0] ?? "")
              ? match[0]
              : "";
            const trailingChar = !matchLower.endsWith(
              searchLower[searchLower.length - 1] ?? "",
            )
              ? match[match.length - 1]
              : "";

            const actualMatch = match.slice(
              leadingChar ? 1 : 0,
              trailingChar ? -1 : undefined,
            );

            const casedReplacement = this.preserveCase(
              actualMatch,
              replacement,
            );

            organizationMappingsResult[searchName] = casedReplacement;
            replacementCount++;

            return `${leadingChar}${casedReplacement}${trailingChar}`;
          });
        }
      }
    }

    return {
      transformedText,
      characterMappings: characterMappingsResult,
      organizationMappings: organizationMappingsResult,
      replacementCount,
    };
  }

  /** Check if text contains any real names that should be replaced */
  async detectRealNames(text: string): Promise<string[]> {
    this.loadMappings();
    const foundNames: string[] = [];

    for (const mapping of this.characterMappingsCache) {
      const searchNames = [mapping.realName, ...mapping.aliases];

      for (const searchName of searchNames) {
        const regex = new RegExp(`\\b${escapeRegex(searchName)}\\b`, "i");

        if (regex.test(text)) {
          foundNames.push(searchName);
        }
      }
    }

    for (const mapping of this.organizationMappingsCache) {
      const searchNames = [mapping.realName, ...mapping.aliases];

      for (const searchName of searchNames) {
        const regex = new RegExp(`\\b${escapeRegex(searchName)}\\b`, "i");

        if (regex.test(text)) {
          foundNames.push(searchName);
        }
      }
    }

    return foundNames;
  }

  async getCharacterMappings(): Promise<ActiveCharacterMapping[]> {
    this.loadMappings();
    return this.characterMappingsCache;
  }

  async getOrganizationMappings(): Promise<ActiveOrganizationMapping[]> {
    this.loadMappings();
    return this.organizationMappingsCache;
  }

  refreshCache(): void {
    this.initialized = false;
    StaticDataRegistry.clearCache();
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Singleton instance
export const characterMappingService = new CharacterMappingService();
