import { usePartialUpdate } from '@/hooks/use-partial-update';
import type { Agent } from '@elizaos/core';
import { useCallback } from 'react';

/**
 * A custom hook for handling Agent updates with specific handling for JSONb fields.
 * This hook builds on usePartialUpdate but adds Agent-specific convenience methods.
 *
 * @param initialAgent The initial Agent object
 * @returns Object with agent state and update methods
 */
export function useAgentUpdate(initialAgent: Agent) {
  const [agent, updateField, updateObject, reset] = usePartialUpdate(initialAgent);

  /**
   * Updates a field in the Agent's settings object
   *
   * @param path Path within settings (e.g., 'voice.model')
   * @param value New value
   */
  const updateSetting = useCallback(
    <T>(path: string, value: T) => {
      updateField(`settings.${path}`, value);
    },
    [updateField]
  );

  /**
   * Updates a secret in the Agent's settings.secrets object
   *
   * @param key Secret key
   * @param value Secret value
   */
  const updateSecret = useCallback(
    (key: string, value: string) => {
      updateField(`settings.secrets.${key}`, value);
    },
    [updateField]
  );

  /**
   * Updates or replaces an array field in the Agent
   *
   * @param fieldName Array field name (e.g., 'plugins', 'bio', etc.)
   * @param value New array value
   */
  const updateArrayField = useCallback(
    <T>(fieldName: string, value: T[]) => {
      updateField(fieldName, value);
    },
    [updateField]
  );

  /**
   * Updates a value in one of the style arrays
   *
   * @param styleType Type of style ('all', 'chat', 'post')
   * @param index Index in the array
   * @param value New value
   */
  const updateStyleItem = useCallback(
    (styleType: 'all' | 'chat' | 'post', index: number, value: string) => {
      updateField(`style.${styleType}.${index}`, value);
    },
    [updateField]
  );

  /**
   * Sets a style array
   *
   * @param styleType Type of style ('all', 'chat', 'post')
   * @param values Array of style values
   */
  const setStyleArray = useCallback(
    (styleType: 'all' | 'chat' | 'post', values: string[]) => {
      updateField(`style.${styleType}`, values);
    },
    [updateField]
  );

  return {
    agent,
    updateField,
    updateObject,
    updateSetting,
    updateSecret,
    updateArrayField,
    updateStyleItem,
    setStyleArray,
    reset,
  };
}
