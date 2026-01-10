import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShellService } from '../services/shellService';
import type { IAgentRuntime } from '@elizaos/core';

// Mock the environment module
vi.mock('../environment', () => ({
  loadShellConfig: () => ({
    enabled: true,
    allowedDirectory: '/test/allowed',
    timeout: 30000,
    forbiddenCommands: ['rm', 'rmdir']
  })
}));

// Mock cross-spawn
vi.mock('cross-spawn', () => ({
  default: vi.fn()
}));

describe('Shell History Tracking', () => {
  let shellService: ShellService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = {} as IAgentRuntime;
    shellService = new ShellService(mockRuntime);
  });

  it('should track command history per conversation', async () => {
    const conversationId = 'test-conversation-1';
    
    // Mock the runCommand method to return success
    vi.spyOn(shellService as any, 'runCommand').mockResolvedValue({
      success: true,
      stdout: 'file1.txt\nfile2.txt',
      stderr: '',
      exitCode: 0,
      executedIn: '/test/allowed'
    });

    // Execute a command
    await shellService.executeCommand('ls', conversationId);
    
    // Get history
    const history = shellService.getCommandHistory(conversationId);
    
    expect(history).toHaveLength(1);
    expect(history[0].command).toBe('ls');
    expect(history[0].stdout).toBe('file1.txt\nfile2.txt');
    expect(history[0].exitCode).toBe(0);
    expect(history[0].workingDirectory).toBe('/test/allowed');
  });

  it('should track file operations', async () => {
    const conversationId = 'test-conversation-2';
    
    // Mock the runCommand method
    vi.spyOn(shellService as any, 'runCommand').mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      executedIn: '/test/allowed'
    });

    // Execute file creation command
    await shellService.executeCommand('touch test.txt', conversationId);
    
    // Get history
    const history = shellService.getCommandHistory(conversationId);
    
    expect(history).toHaveLength(1);
    expect(history[0].fileOperations).toBeDefined();
    expect(history[0].fileOperations![0]).toEqual({
      type: 'create',
      target: '/test/allowed/test.txt'
    });
  });

  it('should clear history for a specific conversation', async () => {
    const conversationId = 'test-conversation-3';
    
    // Mock the runCommand method
    vi.spyOn(shellService as any, 'runCommand').mockResolvedValue({
      success: true,
      stdout: 'output',
      stderr: '',
      exitCode: 0,
      executedIn: '/test/allowed'
    });

    // Execute some commands
    await shellService.executeCommand('ls', conversationId);
    await shellService.executeCommand('pwd', conversationId);
    
    // Verify history exists
    let history = shellService.getCommandHistory(conversationId);
    expect(history).toHaveLength(2);
    
    // Clear history
    shellService.clearCommandHistory(conversationId);
    
    // Verify history is cleared
    history = shellService.getCommandHistory(conversationId);
    expect(history).toHaveLength(0);
  });

  it('should maintain separate history for different conversations', async () => {
    const conversation1 = 'conv-1';
    const conversation2 = 'conv-2';
    
    // Mock the runCommand method
    vi.spyOn(shellService as any, 'runCommand').mockResolvedValue({
      success: true,
      stdout: 'output',
      stderr: '',
      exitCode: 0,
      executedIn: '/test/allowed'
    });

    // Execute commands in different conversations
    await shellService.executeCommand('ls', conversation1);
    await shellService.executeCommand('pwd', conversation2);
    await shellService.executeCommand('echo test', conversation1);
    
    // Check histories are separate
    const history1 = shellService.getCommandHistory(conversation1);
    const history2 = shellService.getCommandHistory(conversation2);
    
    expect(history1).toHaveLength(2);
    expect(history1[0].command).toBe('ls');
    expect(history1[1].command).toBe('echo test');
    
    expect(history2).toHaveLength(1);
    expect(history2[0].command).toBe('pwd');
  });

  it('should detect various file operations', async () => {
    const conversationId = 'test-file-ops';
    
    // Mock the runCommand method
    vi.spyOn(shellService as any, 'runCommand').mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      executedIn: '/test/allowed'
    });

    // Test different file operations
    const commands = [
      { cmd: 'touch newfile.txt', expectedOp: { type: 'create', target: '/test/allowed/newfile.txt' }},
      { cmd: 'echo "hello" > output.txt', expectedOp: { type: 'write', target: '/test/allowed/output.txt' }},
      { cmd: 'mkdir newdir', expectedOp: { type: 'mkdir', target: '/test/allowed/newdir' }},
      { cmd: 'cat input.txt', expectedOp: { type: 'read', target: '/test/allowed/input.txt' }},
    ];

    for (const { cmd, expectedOp } of commands) {
      await shellService.executeCommand(cmd, conversationId);
    }

    const history = shellService.getCommandHistory(conversationId);
    
    expect(history).toHaveLength(commands.length);
    
    commands.forEach((command, index) => {
      expect(history[index].fileOperations![0]).toEqual(command.expectedOp);
    });
  });
}); 