/**
 * A2A Agent Card Generator Unit Tests
 *
 * Tests for the individual agent card generation functions
 */

import { describe, expect, it } from 'bun:test';
import { generateAgentCardSync } from '@feed/a2a';

describe('Agent Card Generator', () => {
  describe('generateAgentCardSync', () => {
    const mockAgent = {
      id: 'agent-12345678-abcd',
      displayName: 'Test Trader Bot',
      bio: 'An autonomous trading agent specializing in prediction markets',
      profileImageUrl: 'https://example.com/avatar.png',
      systemPrompt: 'Advanced market analysis and trading system',
      personality: 'Analytical and risk-aware',
      tradingStrategy: 'Mean reversion with momentum confirmation',
    };

    it('should generate a valid agent card', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card).toBeDefined();
      expect(card.protocolVersion).toBe('0.3.0');
    });

    it('should use agent display name', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.name).toBe('Test Trader Bot');
    });

    it('should use agent bio as description', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.description).toBe(
        'An autonomous trading agent specializing in prediction markets'
      );
    });

    it('should use agent profile image as icon', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.iconUrl).toBe('https://example.com/avatar.png');
    });

    it('should generate correct endpoint URL', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.url).toContain('/api/agents/');
      expect(card.url).toContain(mockAgent.id);
      expect(card.url).toContain('/a2a');
    });

    it('should fallback to truncated ID for name when displayName is null', () => {
      const agentWithNoName = {
        ...mockAgent,
        displayName: null,
      };
      const card = generateAgentCardSync(agentWithNoName);

      expect(card.name).toBe('Agent agent-12');
    });

    it('should fallback to system prompt when bio is null', () => {
      const agentWithNoBio = {
        ...mockAgent,
        bio: null,
      };
      const card = generateAgentCardSync(agentWithNoBio);

      expect(card.description).toBe(
        'Advanced market analysis and trading system'
      );
    });

    it('should fallback to default description when both bio and system are null', () => {
      const agentWithNoDesc = {
        ...mockAgent,
        bio: null,
        systemPrompt: null,
      };
      const card = generateAgentCardSync(agentWithNoDesc);

      expect(card.description).toBe('Autonomous agent on Feed platform');
    });

    it('should have Feed as provider', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.provider?.organization).toBe('Feed');
      expect(card.provider?.url).toBe('https://feed.market');
    });

    it('should prefer JSONRPC transport', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.preferredTransport).toBe('JSONRPC');
    });

    it('should have streaming disabled', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.capabilities.streaming).toBe(false);
    });

    it('should have state transition history enabled', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.capabilities.stateTransitionHistory).toBe(true);
    });

    it('should have skills defined', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.skills).toBeDefined();
      expect(Array.isArray(card.skills)).toBe(true);
      expect(card.skills.length).toBeGreaterThan(0);
    });

    it('should have social skill', () => {
      const card = generateAgentCardSync(mockAgent);

      const socialSkill = card.skills.find((s) => s.id === 'social');
      expect(socialSkill).toBeDefined();
      expect(socialSkill?.name).toBe('Social Features');
    });

    it('should have trading skill', () => {
      const card = generateAgentCardSync(mockAgent);

      const tradingSkill = card.skills.find((s) => s.id === 'trading');
      expect(tradingSkill).toBeDefined();
      expect(tradingSkill?.name).toBe('Prediction Markets');
    });

    it('should have perpetuals skill', () => {
      const card = generateAgentCardSync(mockAgent);

      const perpSkill = card.skills.find((s) => s.id === 'perpetuals');
      expect(perpSkill).toBeDefined();
      expect(perpSkill?.name).toBe('Perpetual Futures');
    });

    it('should have messaging skill', () => {
      const card = generateAgentCardSync(mockAgent);

      const msgSkill = card.skills.find((s) => s.id === 'messaging');
      expect(msgSkill).toBeDefined();
      expect(msgSkill?.name).toBe('Chat & Messaging');
    });

    it('should have additional interfaces', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.additionalInterfaces).toBeDefined();
      expect(card.additionalInterfaces?.length).toBeGreaterThan(0);
    });

    it('should have default input/output modes', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.defaultInputModes).toContain('text/plain');
      expect(card.defaultInputModes).toContain('application/json');
      expect(card.defaultOutputModes).toContain('application/json');
    });

    it('should not support authenticated extended card', () => {
      const card = generateAgentCardSync(mockAgent);

      expect(card.supportsAuthenticatedExtendedCard).toBe(false);
    });
  });
});
