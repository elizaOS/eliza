import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { securityStatusProvider } from '../securityStatus';
import type { IAgentRuntime, Memory, State, UUID } from '@elizaos/core';

// Mocks
const createMockRuntime = (): IAgentRuntime => {
  const securityModuleMock = {
    getRecentSecurityIncidents: vi.fn().mockResolvedValue([]),
    assessThreatLevel: vi.fn().mockResolvedValue(0.2),
    analyzeMessage: vi.fn().mockResolvedValue({ detected: false }),
    getSecurityRecommendations: vi.fn().mockReturnValue([]),
  };
  return {
    getService: vi.fn().mockReturnValue(securityModuleMock),
  } as any;
};

const createMockMemory = (text: string): Memory =>
  ({
    content: { text },
  } as Memory);
  
const mockState: State = {} as State;

describe('securityStatusProvider', () => {
  let runtime: IAgentRuntime;
  let securityModule: any;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
    securityModule = runtime.getService('security-module');
  });

  it('should return NORMAL alert level when threat is low', async () => {
    (securityModule.assessThreatLevel as Mock).mockResolvedValue(0.2);
    const memory = createMockMemory('a normal message');

    const result = await securityStatusProvider.get(runtime, memory, mockState);

    expect(result.text).toContain('Security Status: NORMAL');
    expect(result.values!.alertLevel).toBe('NORMAL');
    expect(result.values!.hasActiveThreats).toBe(false);
  });
  
  it('should return ELEVATED alert level when threat is medium', async () => {
    (securityModule.assessThreatLevel as Mock).mockResolvedValue(0.5);
    const memory = createMockMemory('a slightly worrying message');

    const result = await securityStatusProvider.get(runtime, memory, mockState);

    expect(result.text).toContain('Security Status: ELEVATED');
    expect(result.values!.alertLevel).toBe('ELEVATED');
    expect(result.values!.hasActiveThreats).toBe(true);
  });
  
  it('should return HIGH ALERT when threat is high', async () => {
    (securityModule.assessThreatLevel as Mock).mockResolvedValue(0.8);
    const memory = createMockMemory('a very bad message');

    const result = await securityStatusProvider.get(runtime, memory, mockState);

    expect(result.text).toContain('Security Status: HIGH ALERT');
    expect(result.values!.alertLevel).toBe('HIGH ALERT');
    expect(result.values!.hasActiveThreats).toBe(true);
  });
  
  it('should report recent security incidents in text', async () => {
    (securityModule.getRecentSecurityIncidents as Mock).mockResolvedValue([
        { id: 'inc-1' }, { id: 'inc-2' }
    ]);
    const memory = createMockMemory('a message');
    
    const result = await securityStatusProvider.get(runtime, memory, mockState);

    expect(result.text).toContain('2 security incident(s) detected');
    expect(result.values!.recentIncidentCount).toBe(2);
  });

  it('should include a warning if the current message is flagged', async () => {
    (securityModule.analyzeMessage as Mock).mockResolvedValue({
        detected: true,
        type: 'phishing_attempt'
    });
    const memory = createMockMemory('click here bit.ly/123');
    
    const result = await securityStatusProvider.get(runtime, memory, mockState);

    expect(result.text).toContain('⚠️ Current message flagged: phishing_attempt');
    expect(result.values!.currentMessageFlagged).toBe(true);
    expect(result.values!.securityConcern).toBe('phishing_attempt');
  });

  it('should return gracefully if security module is not available', async () => {
    (runtime.getService as Mock).mockReturnValue(null);
    const memory = createMockMemory('a message');
    
    const result = await securityStatusProvider.get(runtime, memory, mockState);
    
    expect(result.text).toBe('Security module not available');
    expect(result.values).toEqual({});
  });
}); 