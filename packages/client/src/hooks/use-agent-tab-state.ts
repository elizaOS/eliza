import { useState, useEffect, useCallback } from 'react';
import type { UUID } from '@elizaos/core';
import clientLogger from '@/lib/logger';

// Key for storing agent tab states in localStorage
const AGENT_TAB_STATE_KEY = 'eliza-agent-tab-states';

type TabValue = 'details' | 'actions' | 'logs' | 'memories' | string;

interface AgentTabStates {
  [agentId: string]: TabValue;
}

/**
 * Custom hook to manage agent sidebar tab state with localStorage persistence
 * Each agent remembers its last selected tab when switching between agents
 */
export function useAgentTabState(agentId: UUID | undefined) {
  const [currentTab, setCurrentTab] = useState<TabValue>('details');

  // Load tab states from localStorage
  const getStoredTabStates = useCallback((): AgentTabStates => {
    try {
      const stored = localStorage.getItem(AGENT_TAB_STATE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      clientLogger.error('Error reading agent tab states from localStorage:', error);
      return {};
    }
  }, []);

  // Save tab states to localStorage
  const saveTabStates = useCallback((states: AgentTabStates) => {
    try {
      localStorage.setItem(AGENT_TAB_STATE_KEY, JSON.stringify(states));
    } catch (error) {
      clientLogger.error('Error saving agent tab states to localStorage:', error);
    }
  }, []);

  // Load the tab state for the current agent when agentId changes
  useEffect(() => {
    if (!agentId) {
      setCurrentTab('details');
      return;
    }

    const storedStates = getStoredTabStates();
    const agentTabState = storedStates[agentId] || 'details';
    setCurrentTab(agentTabState);
  }, [agentId, getStoredTabStates]);

  // Update tab state and persist to localStorage
  const updateTab = useCallback(
    (newTab: TabValue) => {
      setCurrentTab(newTab);

      if (agentId) {
        const storedStates = getStoredTabStates();
        const updatedStates = {
          ...storedStates,
          [agentId]: newTab,
        };
        saveTabStates(updatedStates);
      }
    },
    [agentId, getStoredTabStates, saveTabStates]
  );

  return {
    currentTab,
    setTab: updateTab,
  };
}
