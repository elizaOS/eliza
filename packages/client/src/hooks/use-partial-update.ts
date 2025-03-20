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
 *   - A function to add an item to an array field
 *   - A function to remove an item from an array field
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
    console.log('[usePartialUpdate] updateField called with path:', path, 'value:', newValue);

    setValue((prevValue) => {
      // Handle simple (non-nested) case
      if (!path.includes('.')) {
        console.log('[usePartialUpdate] Updating simple field:', path);
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

        console.log(
          '[usePartialUpdate] Updating array field:',
          arrayName,
          'index:',
          index,
          'new array:',
          array
        );
        return {
          ...prevValue,
          [arrayName]: array,
        } as T;
      }

      // Special case for settings.secrets path
      if (path.startsWith('settings.secrets.')) {
        const secretKey = path.split('.')[2];
        console.log('[usePartialUpdate] Updating secret:', secretKey, 'with value:', newValue);

        const currentSettings = (prevValue as any).settings || {};
        const currentSecrets = currentSettings.secrets || {};

        const newSecrets = {
          ...currentSecrets,
          [secretKey]: newValue,
        };

        console.log('[usePartialUpdate] New secrets object:', newSecrets);

        return {
          ...prevValue,
          settings: {
            ...currentSettings,
            secrets: newSecrets,
          },
        } as T;
      }

      // Handle regular nested objects
      const result = {
        ...prevValue,
        [fieldToUpdate]: updateNestedObject(
          prevValue[fieldToUpdate as keyof T],
          remainingPath,
          newValue
        ),
      } as T;

      console.log('[usePartialUpdate] Updated value with nested path:', path, 'Result:', result);
      return result;
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
   * Adds an item to an array field
   *
   * @param path Path to the array field
   * @param item Item to add
   */
  const addArrayItem = useCallback(<V>(path: string, item: V) => {
    setValue((prevValue) => {
      const pathParts = path.split('.');

      // Handle simple array field
      if (pathParts.length === 1) {
        const fieldName = pathParts[0];
        const currentArray = Array.isArray(prevValue[fieldName as keyof T])
          ? [...(prevValue[fieldName as keyof T] as unknown as V[])]
          : [];

        return {
          ...prevValue,
          [fieldName]: [...currentArray, item],
        } as T;
      }

      // Handle nested array field
      const updatePath = path;
      const currentValue = getNestedValue(prevValue, updatePath);
      const currentArray = Array.isArray(currentValue) ? [...currentValue] : [];

      return setNestedValue(prevValue, updatePath, [...currentArray, item]);
    });
  }, []);

  /**
   * Removes an item from an array field
   *
   * @param path Path to the array field
   * @param index Index of the item to remove
   */
  const removeArrayItem = useCallback((path: string, index: number) => {
    setValue((prevValue) => {
      const pathParts = path.split('.');

      // Handle simple array field
      if (pathParts.length === 1) {
        const fieldName = pathParts[0];
        const currentArray = Array.isArray(prevValue[fieldName as keyof T])
          ? [...(prevValue[fieldName as keyof T] as unknown as any[])]
          : [];

        if (index < 0 || index >= currentArray.length) return prevValue;

        return {
          ...prevValue,
          [fieldName]: [...currentArray.slice(0, index), ...currentArray.slice(index + 1)],
        } as T;
      }

      // Handle nested array field
      const updatePath = path;
      const currentValue = getNestedValue(prevValue, updatePath);

      if (!Array.isArray(currentValue) || index < 0 || index >= currentValue.length) {
        return prevValue;
      }

      const newArray = [...currentValue.slice(0, index), ...currentValue.slice(index + 1)];
      return setNestedValue(prevValue, updatePath, newArray);
    });
  }, []);

  /**
   * Helper function to get a nested value from an object
   */
  const getNestedValue = (obj: any, path: string): any => {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  };

  /**
   * Helper function to set a nested value in an object
   */
  const setNestedValue = <O, V>(obj: O, path: string, value: V): O => {
    const parts = path.split('.');

    if (parts.length === 1) {
      return {
        ...obj,
        [parts[0]]: value,
      } as O;
    }

    const [first, ...rest] = parts;
    const nextObj = (obj as any)[first] || {};

    return {
      ...obj,
      [first]: setNestedValue(nextObj, rest.join('.'), value),
    } as O;
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

  // Special handling for updating the entire settings object
  const updateSettings = useCallback((settings: any) => {
    console.log('[usePartialUpdate] updateSettings called with:', settings);
    setValue(
      (prevValue) =>
        ({
          ...prevValue,
          settings,
        }) as T
    );
  }, []);

  return {
    value,
    updateField,
    addArrayItem,
    removeArrayItem,
    updateObject,
    reset,
    updateSettings,
  };
}
