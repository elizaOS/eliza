import { usePartialUpdate } from '@/hooks/use-partial-update';
import type { Agent } from '@elizaos/core';
import { useCallback } from 'react';

/**
 * A custom hook for handling Agent updates with specific handling for JSONb fields.
 * This hook builds on usePartialUpdate but adds Agent-specific convenience methods
 * organized by the UI tabs (Basic Info, Content, Style, Plugins, etc.).
 *
 * @param initialAgent The initial Agent object
 * @returns Object with agent state and update methods
 */
export function useAgentUpdate(initialAgent: Agent) {
  const {
    value: agent,
    updateField,
    addArrayItem,
    removeArrayItem,
    updateObject,
    reset,
    updateSettings,
  } = usePartialUpdate(initialAgent);

  // ==================== Basic Info Tab ====================
  /**
   * Updates a field in the Agent's settings object
   *
   * @param path Path within settings (e.g., 'voice.model')
   * @param value New value
   */
  const updateSetting = useCallback(
    <T>(path: string, value: T) => {
      console.log('[useAgentUpdate] updateSetting called for path:', path, 'value:', value);
      updateField(`settings.${path}`, value);
    },
    [updateField]
  );

  /**
   * Updates the entire settings object
   *
   * @param settings The new settings object
   */
  const setSettings = useCallback(
    (settings: any) => {
      console.log('[useAgentUpdate] setSettings called with:', settings);
      updateSettings(settings);
    },
    [updateSettings]
  );

  /**
   * Updates the agent's system prompt
   *
   * @param systemPrompt The new system prompt
   */
  const updateSystemPrompt = useCallback(
    (systemPrompt: string) => {
      updateField('system', systemPrompt);
    },
    [updateField]
  );

  // ==================== Secrets Tab ====================
  /**
   * Updates a secret in the Agent's settings.secrets object
   *
   * @param key Secret key
   * @param value Secret value
   */
  const updateSecret = useCallback(
    (key: string, value: string) => {
      console.log('[useAgentUpdate] updateSecret called for key:', key, 'value:', value);

      // Handle nested secrets object properly
      const currentSettings = agent.settings || {};
      const currentSecrets = currentSettings.secrets || {};

      const newSecrets = {
        ...currentSecrets,
        [key]: value,
      };

      console.log('[useAgentUpdate] New secrets object:', newSecrets);

      // Update entire settings object for better change detection
      updateSettings({
        ...currentSettings,
        secrets: newSecrets,
      });
    },
    [agent.settings, updateSettings]
  );

  /**
   * Removes a secret from the Agent's settings.secrets object
   *
   * @param key Secret key to remove
   */
  const removeSecret = useCallback(
    (key: string) => {
      console.log('[useAgentUpdate] removeSecret called for key:', key);

      // Get the current secrets object
      const currentSettings = agent.settings || {};
      const currentSecrets = currentSettings.secrets || {};

      console.log('[useAgentUpdate] Current secrets before removal:', currentSecrets);

      // Create a new secrets object without the removed key
      const newSecrets = { ...currentSecrets };
      delete newSecrets[key];

      console.log('[useAgentUpdate] New secrets after removal:', newSecrets);

      // Update the entire settings object to ensure nested changes are detected
      const updatedSettings = {
        ...currentSettings,
        secrets: newSecrets,
      };

      console.log('[useAgentUpdate] Updated settings with removed secret:', updatedSettings);

      // Use updateSettings instead of updateField for better change detection
      updateSettings(updatedSettings);
    },
    [agent.settings, updateSettings]
  );

  // ==================== Content Tab ====================
  /**
   * Adds an item to a content array (bio, topics, adjectives)
   *
   * @param arrayName The name of the array field
   * @param item The item to add
   */
  const addContentItem = useCallback(
    (arrayName: 'bio' | 'topics' | 'adjectives', item: string) => {
      addArrayItem(arrayName, item);
    },
    [addArrayItem]
  );

  /**
   * Removes an item from a content array
   *
   * @param arrayName The name of the array field
   * @param index The index of the item to remove
   */
  const removeContentItem = useCallback(
    (arrayName: 'bio' | 'topics' | 'adjectives', index: number) => {
      removeArrayItem(arrayName, index);
    },
    [removeArrayItem]
  );

  /**
   * Updates an item in a content array
   *
   * @param arrayName The name of the array field
   * @param index The index of the item to update
   * @param value The new value
   */
  const updateContentItem = useCallback(
    (arrayName: 'bio' | 'topics' | 'adjectives', index: number, value: string) => {
      updateField(`${arrayName}.${index}`, value);
    },
    [updateField]
  );

  // ==================== Style Tab ====================
  /**
   * Adds a style rule to one of the style arrays
   *
   * @param styleType Type of style ('all', 'chat', 'post')
   * @param rule The style rule to add
   */
  const addStyleRule = useCallback(
    (styleType: 'all' | 'chat' | 'post', rule: string) => {
      addArrayItem(`style.${styleType}`, rule);
    },
    [addArrayItem]
  );

  /**
   * Removes a style rule from one of the style arrays
   *
   * @param styleType Type of style ('all', 'chat', 'post')
   * @param index The index of the rule to remove
   */
  const removeStyleRule = useCallback(
    (styleType: 'all' | 'chat' | 'post', index: number) => {
      removeArrayItem(`style.${styleType}`, index);
    },
    [removeArrayItem]
  );

  /**
   * Updates a style rule in one of the style arrays
   *
   * @param styleType Type of style ('all', 'chat', 'post')
   * @param index The index of the rule to update
   * @param value The new rule value
   */
  const updateStyleRule = useCallback(
    (styleType: 'all' | 'chat' | 'post', index: number, value: string) => {
      updateField(`style.${styleType}.${index}`, value);
    },
    [updateField]
  );

  /**
   * Sets a complete style array
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

  // ==================== Plugins Tab ====================
  /**
   * Adds a plugin to the agent's plugins array
   *
   * @param pluginId The plugin ID to add
   */
  const addPlugin = useCallback(
    (pluginId: string) => {
      addArrayItem('plugins', pluginId);
    },
    [addArrayItem]
  );

  /**
   * Removes a plugin from the agent's plugins array
   *
   * @param index The index of the plugin to remove
   */
  const removePlugin = useCallback(
    (index: number) => {
      removeArrayItem('plugins', index);
    },
    [removeArrayItem]
  );

  /**
   * Sets the entire plugins array
   *
   * @param plugins Array of plugin IDs
   */
  const setPlugins = useCallback(
    (plugins: string[]) => {
      updateField('plugins', plugins);
    },
    [updateField]
  );

  // ==================== Avatar Tab ====================
  /**
   * Updates the agent's avatar
   *
   * @param avatarUrl The URL of the avatar image
   */
  const updateAvatar = useCallback(
    (avatarUrl: string) => {
      updateSetting('avatar', avatarUrl);
    },
    [updateSetting]
  );

  return {
    agent,
    // Original methods
    updateField,
    updateObject,
    reset,
    updateSettings,
    setSettings,

    // Basic Info Tab
    updateSetting,
    updateSystemPrompt,

    // Secrets Tab
    updateSecret,
    removeSecret,

    // Content Tab
    addContentItem,
    removeContentItem,
    updateContentItem,

    // Style Tab
    addStyleRule,
    removeStyleRule,
    updateStyleRule,
    setStyleArray,

    // Plugins Tab
    addPlugin,
    removePlugin,
    setPlugins,

    // Avatar Tab
    updateAvatar,
  };
}
