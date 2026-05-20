/**
 * A2A Babylon Agent Card Unit Tests
 *
 * Tests for the Babylon platform agent card definition
 */

import { describe, expect, it } from 'bun:test';
import { babylonAgentCard } from '@babylon/a2a';

describe('Babylon Agent Card', () => {
  describe('Protocol Compliance', () => {
    it('should have correct protocol version', () => {
      expect(babylonAgentCard.protocolVersion).toBe('0.3.0');
    });

    it('should have correct name and description', () => {
      expect(babylonAgentCard.name).toBe('Babylon');
      expect(babylonAgentCard.description).toContain('social conspiracy game');
      expect(babylonAgentCard.description).toContain('prediction markets');
    });

    it('should have valid URL endpoint', () => {
      expect(babylonAgentCard.url).toContain('/api/a2a');
    });

    it('should prefer JSONRPC transport', () => {
      expect(babylonAgentCard.preferredTransport).toBe('JSONRPC');
    });
  });

  describe('Provider Information', () => {
    it('should have Babylon as provider', () => {
      expect(babylonAgentCard.provider?.organization).toBe('Babylon');
      expect(babylonAgentCard.provider?.url).toBe('https://babylon.market');
    });
  });

  describe('Capabilities', () => {
    it('should declare streaming not supported', () => {
      expect(babylonAgentCard.capabilities.streaming).toBe(false);
    });

    it('should declare push notifications not supported', () => {
      expect(babylonAgentCard.capabilities.pushNotifications).toBe(false);
    });

    it('should declare state transition history supported', () => {
      expect(babylonAgentCard.capabilities.stateTransitionHistory).toBe(true);
    });
  });

  describe('Security Configuration', () => {
    it('should have API key security scheme', () => {
      expect(babylonAgentCard.securitySchemes).toBeDefined();
      expect(babylonAgentCard.securitySchemes?.babylonApiKey).toBeDefined();
    });

    it('should use header-based API key', () => {
      const scheme = babylonAgentCard.securitySchemes?.babylonApiKey;
      expect(scheme?.type).toBe('apiKey');
      expect((scheme as { in?: string })?.in).toBe('header');
      expect((scheme as { name?: string })?.name).toBe('X-Babylon-Api-Key');
    });

    it('should have security requirements', () => {
      expect(babylonAgentCard.security).toBeDefined();
      expect(babylonAgentCard.security?.length).toBeGreaterThan(0);
    });
  });

  describe('Input/Output Modes', () => {
    it('should support text and JSON input', () => {
      expect(babylonAgentCard.defaultInputModes).toContain('text/plain');
      expect(babylonAgentCard.defaultInputModes).toContain('application/json');
    });

    it('should support JSON and text output', () => {
      expect(babylonAgentCard.defaultOutputModes).toContain('application/json');
      expect(babylonAgentCard.defaultOutputModes).toContain('text/plain');
    });
  });

  describe('Skills', () => {
    it('should have defined skills array', () => {
      expect(babylonAgentCard.skills).toBeDefined();
      expect(Array.isArray(babylonAgentCard.skills)).toBe(true);
      expect(babylonAgentCard.skills.length).toBeGreaterThan(0);
    });

    it('should have social-feed skill', () => {
      const socialSkill = babylonAgentCard.skills.find(
        (s) => s.id === 'social-feed'
      );
      expect(socialSkill).toBeDefined();
      expect(socialSkill?.name).toContain('Social');
      expect(socialSkill?.tags).toContain('social');
    });

    it('should have prediction-markets skill', () => {
      const marketSkill = babylonAgentCard.skills.find(
        (s) => s.id === 'prediction-markets'
      );
      expect(marketSkill).toBeDefined();
      expect(marketSkill?.name).toContain('Prediction Market');
      expect(marketSkill?.tags).toContain('trading');
    });

    it('should have perpetual-futures skill', () => {
      const perpSkill = babylonAgentCard.skills.find(
        (s) => s.id === 'perpetual-futures'
      );
      expect(perpSkill).toBeDefined();
      expect(perpSkill?.name).toContain('Perpetual');
      expect(perpSkill?.tags).toContain('perpetuals');
    });

    it('should have messaging-chats skill', () => {
      const chatSkill = babylonAgentCard.skills.find(
        (s) => s.id === 'messaging-chats'
      );
      expect(chatSkill).toBeDefined();
      expect(chatSkill?.tags).toContain('messaging');
    });

    it('should have moderation-escrow skill', () => {
      const escrowSkill = babylonAgentCard.skills.find(
        (s) => s.id === 'moderation-escrow'
      );
      expect(escrowSkill).toBeDefined();
      expect(escrowSkill?.tags).toContain('escrow');
      expect(escrowSkill?.tags).toContain('moderation');
    });

    it('should have portfolio-balance skill', () => {
      const portfolioSkill = babylonAgentCard.skills.find(
        (s) => s.id === 'portfolio-balance'
      );
      expect(portfolioSkill).toBeDefined();
      expect(portfolioSkill?.tags).toContain('portfolio');
    });

    it('should have examples for each skill', () => {
      for (const skill of babylonAgentCard.skills) {
        expect(skill.examples).toBeDefined();
        expect(skill.examples?.length).toBeGreaterThan(0);
      }
    });

    it('should have valid input/output modes for each skill', () => {
      for (const skill of babylonAgentCard.skills) {
        expect(skill.inputModes).toBeDefined();
        expect(skill.outputModes).toBeDefined();
        expect(skill.outputModes).toContain('application/json');
      }
    });
  });

  describe('Additional Interfaces', () => {
    it('should have at least one additional interface', () => {
      expect(babylonAgentCard.additionalInterfaces).toBeDefined();
      expect(babylonAgentCard.additionalInterfaces?.length).toBeGreaterThan(0);
    });

    it('should use JSONRPC for additional interfaces', () => {
      const interfaces = babylonAgentCard.additionalInterfaces;
      if (interfaces) {
        for (const iface of interfaces) {
          expect(iface.transport).toBe('JSONRPC');
        }
      }
    });
  });
});
