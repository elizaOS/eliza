import { deepMerge } from '@/lib/utils';
import { useState, useCallback } from 'react';

/**
 * A custom hook for handling partial updates of objects with nested JSONb fields.
 * This hook ensures that updates to nested objects and arrays are properly
 * managed when sending updates to the server.
 *
 * @param initialValue The initial state object
 * @returns A tuple containing:
 *   - The current state object
 *   - A function to update a specific field (handles nested paths)
 *   - A function to set the entire object
 *   - A function to reset to initial state
 */
export function usePartialUpdate<T extends object>(initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);

  /**
   * Updates a specific field in the object, handling nested paths
   *
   * @param path The path to the field to update (e.g., 'settings.voice.model')
   * @param newValue The new value for the field
   */
  const updateField = useCallback(<K>(path: string, newValue: K) => {
    setValue((prevValue) => {
      // Handle simple (non-nested) case
      if (!path.includes('.')) {
        return {
          ...prevValue,
          [path]: newValue,
        } as T;
      }

      // Handle nested paths
      const pathParts = path.split('.');
      const fieldToUpdate = pathParts[0];
      const remainingPath = pathParts.slice(1).join('.');

      // Handle arrays in path (e.g., 'style.all.0')
      const isArrayIndex = !isNaN(Number(pathParts[1]));

      if (isArrayIndex) {
        const arrayName = pathParts[0];
        const index = Number(pathParts[1]);
        // Ensure we're working with an array and handle it safely
        const currentValue = prevValue[arrayName as keyof T];
        const array = Array.isArray(currentValue) ? [...currentValue] : [];

        if (pathParts.length === 2) {
          // Direct array item update
          array[index] = newValue;
        } else {
          // Updating a property of an object in an array
          const deeperPath = pathParts.slice(2).join('.');
          array[index] = updateNestedObject(array[index], deeperPath, newValue);
        }

        return {
          ...prevValue,
          [arrayName]: array,
        } as T;
      }

      // Handle regular nested objects
      return {
        ...prevValue,
        [fieldToUpdate]: updateNestedObject(
          prevValue[fieldToUpdate as keyof T],
          remainingPath,
          newValue
        ),
      } as T;
    });
  }, []);

  /**
   * Helper function to update a nested object
   */
  const updateNestedObject = <K, V>(obj: K, path: string, value: V): K => {
    if (!path.includes('.')) {
      return {
        ...obj,
        [path]: value,
      } as unknown as K;
    }

    const [field, ...remainingPath] = path.split('.');
    const nextPath = remainingPath.join('.');

    return {
      ...obj,
      [field]: updateNestedObject((obj as any)[field] || {}, nextPath, value),
    } as unknown as K;
  };

  /**
   * Updates the entire object using deep merge
   */
  const updateObject = useCallback((newPartialValue: Partial<T>) => {
    setValue((prev) => deepMerge(prev, newPartialValue));
  }, []);

  /**
   * Resets to the initial state
   */
  const reset = useCallback(() => {
    setValue(initialValue);
  }, [initialValue]);

  return [value, updateField, updateObject, reset] as const;
}
