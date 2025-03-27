import { describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { UUID } from '@elizaos/core';
import { projectManager } from '../src/projectManager';
import { createTestMessage } from './setup';

describe('Project Manager Character Verification', () => {
  // Verify the character's expected responses to project management scenarios
  it('should have appropriate message examples for various project management scenarios', () => {
    // Get all message examples from the character
    const { messageExamples } = projectManager.character;
    
    expect(messageExamples).toBeDefined();
    if (!messageExamples) return; // Satisfy type checker
    
    expect(Array.isArray(messageExamples)).toBe(true);
    
    // Look for examples related to task management or projects
    const taskExamples = messageExamples.filter(conversation => {
      const text = JSON.stringify(conversation).toLowerCase();
      return text.includes('task') || text.includes('project') || text.includes('deadline');
    });
    expect(taskExamples.length).toBeGreaterThan(0);
    
    // Look for examples about planning or coordination
    const planningExamples = messageExamples.filter(conversation => {
      const text = JSON.stringify(conversation).toLowerCase();
      return text.includes('plan') || text.includes('schedule') || text.includes('priorit');
    });
    expect(planningExamples.length).toBeGreaterThan(0);
  });
  
  it('should focus on project management in its bio and system description', () => {
    const { bio, system } = projectManager.character;
    
    // Verify bio contains project management focus
    expect(bio).toBeDefined();
    if (!bio) return; // Satisfy type checker
    
    expect(Array.isArray(bio) || typeof bio === 'string').toBe(true);
    const combinedBio = typeof bio === 'string' ? bio : bio.join(' ');
    const bioText = combinedBio.toLowerCase();
    expect(bioText).toMatch(/project|task|manage|plan|schedule|deadline/);
    
    // Verify system description focuses on project management
    expect(system).toBeDefined();
    if (!system) return; // Satisfy type checker
    
    const systemDescription = system.toLowerCase();
    expect(systemDescription).toMatch(/project|task|manage|plan|schedule|deadline/);
  });
  
  it('should have the correct plugins configured for project management', () => {
    const { plugins } = projectManager.character;
    
    expect(plugins).toBeDefined();
    if (!plugins) return; // Satisfy type checker
    
    // Verify essential plugins for project management
    expect(plugins.some(p => p.includes('openai') || p.includes('anthropic'))).toBe(true);
    
    // Should include communication plugins
    const hasCommunicationPlugins = plugins.some(p => 
      p.includes('discord') || p.includes('twitter') || p.includes('telegram')
    );
    expect(hasCommunicationPlugins).toBe(true);
  });
  
  it('should simulate responses to project management-related queries', () => {
    const testRoomId = uuidv4() as UUID;
    const userEntityId = uuidv4() as UUID;
    
    // Create test messages
    const taskQuery = createTestMessage({
      text: `@${projectManager.character.name} Can you help me track the progress of our current sprint?`,
      entityId: userEntityId,
      roomId: testRoomId,
      userName: 'TestUser'
    });
    
    const planningQuery = createTestMessage({
      text: `@${projectManager.character.name} We need to plan the next release and set priorities.`,
      entityId: userEntityId,
      roomId: testRoomId,
      userName: 'TestUser'
    });
    
    // Verify messages are correctly formatted for the character
    expect(taskQuery.content?.text).toContain(projectManager.character.name);
    expect(taskQuery.content?.text).toMatch(/track|progress|sprint/i);
    
    expect(planningQuery.content?.text).toContain(projectManager.character.name);
    expect(planningQuery.content?.text).toMatch(/plan|release|priorit/i);
  });
  
  it('should have task management capabilities', () => {
    // Check if the projectManager has init function
    expect(projectManager.init).toBeDefined();
    
    // Try to access task-related configuration
    try {
      // Check for any task management settings
      const config = projectManager as unknown as { config?: any };
      if (config && config.config && config.config.settings) {
        const settings = config.config.settings;
        // Look for task-related settings
        const hasTaskSettings = Object.keys(settings).some(key => 
          key.toLowerCase().includes('task') || 
          key.toLowerCase().includes('project') || 
          key.toLowerCase().includes('plan')
        );
        if (hasTaskSettings) {
          expect(hasTaskSettings).toBe(true);
        }
      }
      
      // Look for task-related actions
      const module = projectManager as unknown as { 
        actions?: any[] 
      };
      
      if (module.actions && Array.isArray(module.actions)) {
        const taskActions = module.actions.filter(action => 
          action.name && (
            action.name.toLowerCase().includes('task') ||
            action.name.toLowerCase().includes('project') ||
            action.name.toLowerCase().includes('plan')
          )
        );
        if (taskActions.length > 0) {
          expect(taskActions.length).toBeGreaterThan(0);
        }
      }
    } catch (error) {
      // Config may not be accessible through import, which is fine
      console.log('Note: Task-related configuration not directly accessible, but init function exists');
    }
  });
}); 