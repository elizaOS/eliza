import { usePartialUpdate } from '@/hooks/use-partial-update';
import type { Agent, Character } from '@elizaos/core';
import { useCallback, useRef } from 'react';

/**
 * A custom hook for handling Agent updates with specific handling for JSONb fields.
 * This hook builds on usePartialUpdate but adds Agent-specific convenience methods
 * organized by the UI tabs (Basic Info, Content, Style, Plugins, etc.).
 *
 * @param initialAgent The initial Agent object
 * @returns Object with agent state and update methods
 */
export function useAgentUpdate(initialAgent: Agent) {
  // Keep reference to the initial state for comparison
  const initialAgentRef = useRef<Agent>(JSON.parse(JSON.stringify(initialAgent)));

  const {
    value: agent,
    updateField,
    addArrayItem,
    removeArrayItem,
    reset,
    updateSettings,
  } = usePartialUpdate(initialAgent);

  // ==================== Template Import Function ====================
  /**
   * Imports a full agent template - overwrites all fields
   *
   * @param templateAgent The agent template to import
   */
  const importAgent = useCallback(
    (templateAgent: Character) => {
      // For each top-level property in the template, update it in the current agent
      Object.entries(templateAgent).forEach(([key, value]) => {
        if (key === 'settings' && value) {
          // Handle settings object specially to preserve existing settings not in template
          updateSettings({
            ...agent.settings,
            ...value,
          });
        } else if (key === 'style' && value) {
          // Handle style object specially - it's nested but needs direct update
          updateField('style', {
            all: value.all || [],
            chat: value.chat || [],
            post: value.post || [],
          });
        } else if (Array.isArray(value)) {
          // Handle arrays directly to ensure they fully replace existing arrays
          updateField(key, [...value]);
        } else {
          // For other fields, directly update
          updateField(key, value);
        }
      });
    },
    [agent.settings, updateField, updateSettings]
  );

  // ==================== Basic Info Tab ====================
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
   * Updates the entire settings object
   *
   * @param settings The new settings object
   */
  const setSettings = useCallback(
    (settings: any) => {
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
      // Handle nested secrets object properly
      const currentSettings = agent.settings || {};
      const currentSecrets = currentSettings.secrets || {};

      const newSecrets = {
        ...currentSecrets,
        [key]: value,
      };

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
      // Get the current secrets object
      const currentSettings = agent.settings || {};
      const currentSecrets = currentSettings.secrets || {};

      // Create a new secrets object without the removed key
      const newSecrets = { ...currentSecrets };
      delete newSecrets[key];

      // Update the entire settings object to ensure nested changes are detected
      const updatedSettings = {
        ...currentSettings,
        secrets: newSecrets,
      };

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

  /**
   * Returns an object containing only the fields that have changed
   * compared to the initial agent state
   */
  const getChangedFields = useCallback(() => {
    const changedFields: Partial<Agent> = {};
    const current = agent;
    const initial = initialAgentRef.current;

    // Compare scalar properties
    const scalarProps = ['name', 'username', 'system'] as const;
    scalarProps.forEach((prop) => {
      if (current[prop] !== initial[prop]) {
        changedFields[prop] = current[prop];
      }
    });

    if (current.enabled !== initial.enabled) {
      changedFields.enabled = current.enabled;
    }

    // Compare array properties with type safety
    if (JSON.stringify(current.bio) !== JSON.stringify(initial.bio)) {
      changedFields.bio = current.bio;
    }

    if (JSON.stringify(current.topics) !== JSON.stringify(initial.topics)) {
      changedFields.topics = current.topics;
    }

    if (JSON.stringify(current.adjectives) !== JSON.stringify(initial.adjectives)) {
      changedFields.adjectives = current.adjectives;
    }

    if (JSON.stringify(current.plugins) !== JSON.stringify(initial.plugins)) {
      changedFields.plugins = current.plugins;
    }

    // Compare style object
    if (JSON.stringify(current.style) !== JSON.stringify(initial.style)) {
      changedFields.style = current.style;
    }

    // More granular comparison for settings object
    const initialSettings = initial.settings || {};
    const currentSettings = current.settings || {};

    // Check if any settings changed
    if (JSON.stringify(currentSettings) !== JSON.stringify(initialSettings)) {
      // Create a partial settings object with only changed fields
      changedFields.settings = {};

      // Check avatar separately
      if (currentSettings.avatar !== initialSettings.avatar) {
        changedFields.settings.avatar = currentSettings.avatar;
      }

      // Check voice settings
      if (JSON.stringify(currentSettings.voice) !== JSON.stringify(initialSettings.voice)) {
        changedFields.settings.voice = currentSettings.voice;
      }

      // Check secrets with special handling
      if (JSON.stringify(currentSettings.secrets) !== JSON.stringify(initialSettings.secrets)) {
        const initialSecrets = initialSettings.secrets || {};
        const currentSecrets = currentSettings.secrets || {};

        // Only include secrets that were added or modified
        const changedSecrets: Record<string, any> = {};
        let hasSecretChanges = false;

        // Find added or modified secrets
        Object.entries(currentSecrets).forEach(([key, value]) => {
          if (initialSecrets[key] !== value) {
            changedSecrets[key] = value;
            hasSecretChanges = true;
          }
        });

        // Find deleted secrets (null values indicate deletion)
        Object.keys(initialSecrets).forEach((key) => {
          if (currentSecrets[key] === undefined) {
            changedSecrets[key] = null;
            hasSecretChanges = true;
          }
        });

        if (hasSecretChanges) {
          if (!changedFields.settings) changedFields.settings = {};
          changedFields.settings.secrets = changedSecrets;
        }
      }

      // If no specific settings changed, don't include settings object
      if (Object.keys(changedFields.settings).length === 0) {
        delete changedFields.settings;
      }
    }

    return changedFields;
  }, [agent]);

  return {
    agent,
    updateField,
    reset,
    updateSettings,
    setSettings,

    // Method to get only changed fields
    getChangedFields,

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

    importAgent,
  };
}
