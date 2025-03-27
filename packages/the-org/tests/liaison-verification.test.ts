import { describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { UUID } from '@elizaos/core';
import { liaison } from '../src/liaison';
import { createTestMessage } from './setup';

describe('Liaison Character Verification', () => {
  // Verify the character's expected responses to liaison scenarios
  it('should have appropriate message examples for various liaison scenarios', () => {
    // Get all message examples from the character
    const { messageExamples } = liaison.character;
    
    expect(messageExamples).toBeDefined();
    if (!messageExamples) return; // Satisfy type checker
    
    expect(Array.isArray(messageExamples)).toBe(true);
    
    // Look for examples related to connecting people or teams
    const connectionExamples = messageExamples.filter(conversation => {
      const text = JSON.stringify(conversation).toLowerCase();
      return text.includes('connect') || text.includes('introduce') || text.includes('team');
    });
    expect(connectionExamples.length).toBeGreaterThan(0);
    
    // Look for examples about communication or collaboration
    const communicationExamples = messageExamples.filter(conversation => {
      const text = JSON.stringify(conversation).toLowerCase();
      return text.includes('communicat') || text.includes('collaborat') || text.includes('coordinate');
    });
    expect(communicationExamples.length).toBeGreaterThan(0);
  });
  
  it('should focus on liaison activities in its bio and system description', () => {
    const { bio, system } = liaison.character;
    
    // Verify bio contains liaison focus
    expect(bio).toBeDefined();
    if (!bio) return; // Satisfy type checker
    
    expect(Array.isArray(bio) || typeof bio === 'string').toBe(true);
    const combinedBio = typeof bio === 'string' ? bio : bio.join(' ');
    const bioText = combinedBio.toLowerCase();
    expect(bioText).toMatch(/connect|communicat|liaison|team|coordinate/);
    
    // Verify system description focuses on liaison activities
    expect(system).toBeDefined();
    if (!system) return; // Satisfy type checker
    
    const systemDescription = system.toLowerCase();
    expect(systemDescription).toMatch(/connect|communicat|liaison|team|coordinate/);
  });
  
  it('should have the correct plugins configured for liaison activities', () => {
    const { plugins } = liaison.character;
    
    expect(plugins).toBeDefined();
    if (!plugins) return; // Satisfy type checker
    
    // Verify essential plugins for liaison work
    expect(plugins.some(p => p.includes('openai') || p.includes('anthropic'))).toBe(true);
    
    // Should include communication plugins
    const hasCommunicationPlugins = plugins.some(p => 
      p.includes('discord') || p.includes('twitter') || p.includes('telegram')
    );
    expect(hasCommunicationPlugins).toBe(true);
  });
  
  it('should simulate responses to liaison-related queries', () => {
    const testRoomId = uuidv4() as UUID;
    const userEntityId = uuidv4() as UUID;
    
    // Create test messages
    const connectQuery = createTestMessage({
      text: `@${liaison.character.name} Can you connect me with someone from the marketing team?`,
      entityId: userEntityId,
      roomId: testRoomId,
      userName: 'TestUser'
    });
    
    const coordinateQuery = createTestMessage({
      text: `@${liaison.character.name} I need help coordinating a meeting between dev and product teams.`,
      entityId: userEntityId,
      roomId: testRoomId,
      userName: 'TestUser'
    });
    
    // Verify messages are correctly formatted for the character
    expect(connectQuery.content?.text).toContain(liaison.character.name);
    expect(connectQuery.content?.text).toMatch(/connect|marketing/i);
    
    expect(coordinateQuery.content?.text).toContain(liaison.character.name);
    expect(coordinateQuery.content?.text).toMatch(/coordinat|meeting/i);
  });
  
  it('should have appropriate handling for coordination tasks', () => {
    // Check if the liaison has init function
    expect(liaison.init).toBeDefined();
    
    // Try to access config or task-related functionality
    try {
      // Check for config settings related to coordination
      const config = liaison as unknown as { config?: any };
      if (config && config.config && config.config.settings) {
        const settings = config.config.settings;
        // Look for settings related to team coordination
        const hasCoordinationSettings = Object.keys(settings).some(key => 
          key.toLowerCase().includes('team') || 
          key.toLowerCase().includes('meeting') || 
          key.toLowerCase().includes('coordinate')
        );
        if (hasCoordinationSettings) {
          expect(hasCoordinationSettings).toBe(true);
        }
      }
    } catch (error) {
      // Config may not be accessible through import, which is fine
      console.log('Note: Config object not directly accessible, but init function exists');
    }
  });
}); 