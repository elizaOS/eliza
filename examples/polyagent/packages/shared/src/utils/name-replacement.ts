/**
 * Utility functions for name replacement checks
 * Handles various case formats: first, last, firstlast, FirstLast, FIRSTLAST, FIRST, First, LAST, Last, First Last, first last, FIRST LAST, etc.
 */

export interface NameParts {
  firstName: string;
  lastName: string;
  originalFirstName: string;
  originalLastName: string;
}

/**
 * Generates all possible name variations for replacement checking
 */
export function generateNameVariations(
  firstName: string,
  lastName: string,
): string[] {
  const variations: Set<string> = new Set();

  // Individual parts
  variations.add(firstName.toLowerCase());
  variations.add(firstName);
  variations.add(firstName.toUpperCase());
  variations.add(lastName.toLowerCase());
  variations.add(lastName);
  variations.add(lastName.toUpperCase());

  // Combined variations
  const firstLower = firstName.toLowerCase();
  const lastLower = lastName.toLowerCase();
  const firstUpper = firstName.toUpperCase();
  const lastUpper = lastName.toUpperCase();
  const firstTitle =
    firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  const lastTitle =
    lastName.charAt(0).toUpperCase() + lastName.slice(1).toLowerCase();

  // firstlast (all lowercase)
  variations.add(firstLower + lastLower);

  // FirstLast (title case)
  variations.add(firstTitle + lastTitle);

  // FIRSTLAST (all uppercase)
  variations.add(firstUpper + lastUpper);

  // firstLast (camelCase)
  variations.add(firstLower + lastTitle);

  // First_Last (with underscore)
  variations.add(`${firstTitle}_${lastTitle}`);
  variations.add(`${firstLower}_${lastLower}`);
  variations.add(`${firstUpper}_${lastUpper}`);

  // First-Last (with hyphen)
  variations.add(`${firstTitle}-${lastTitle}`);
  variations.add(`${firstLower}-${lastLower}`);
  variations.add(`${firstUpper}-${lastUpper}`);

  // First Last (with space)
  variations.add(`${firstTitle} ${lastTitle}`);
  variations.add(`${firstLower} ${lastLower}`);
  variations.add(`${firstUpper} ${lastUpper}`);

  // First, Last (with comma)
  variations.add(`${firstTitle}, ${lastTitle}`);
  variations.add(`${firstLower}, ${lastLower}`);
  variations.add(`${firstUpper}, ${lastUpper}`);

  return Array.from(variations).filter((v) => v.length > 0);
}

/**
 * Checks if a text contains any name variations
 */
export function containsNameVariation(
  text: string,
  firstName: string,
  lastName: string,
): boolean {
  const variations = generateNameVariations(firstName, lastName);
  const lowerText = text.toLowerCase();

  return variations.some((variation) => {
    const lowerVariation = variation.toLowerCase();
    // Check for exact word boundaries or as part of larger words
    const regex = new RegExp(
      `\\b${lowerVariation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    );
    return regex.test(lowerText);
  });
}

/**
 * Replaces all name variations in text
 */
export function replaceNameVariations(
  text: string,
  oldFirstName: string,
  oldLastName: string,
  newFirstName: string,
  newLastName: string,
): string {
  let result = text;
  const oldVariations = generateNameVariations(oldFirstName, oldLastName);
  const newVariations = generateNameVariations(newFirstName, newLastName);

  // Sort by length (longest first) to avoid partial replacements
  const sortedOld = oldVariations.sort((a, b) => b.length - a.length);
  const sortedNew = newVariations.sort((a, b) => b.length - a.length);

  // Replace each variation
  for (let i = 0; i < sortedOld.length; i++) {
    const oldVar = sortedOld[i];
    if (!oldVar) {
      continue;
    }
    const newVar = sortedNew[i] || `${newFirstName} ${newLastName}`;

    // Use word boundaries for replacement
    const regex = new RegExp(
      `\\b${oldVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    );
    result = result.replace(regex, newVar);
  }

  return result;
}

/**
 * Extracts name parts from an actor object
 */
export function extractNameParts(actor: {
  firstName?: string;
  lastName?: string;
  originalFirstName?: string;
  originalLastName?: string;
}): NameParts | null {
  if (
    !actor.firstName ||
    actor.lastName === undefined ||
    !actor.originalFirstName ||
    actor.originalLastName === undefined
  ) {
    return null;
  }

  return {
    firstName: actor.firstName,
    lastName: actor.lastName,
    originalFirstName: actor.originalFirstName,
    originalLastName: actor.originalLastName,
  };
}
