import { describe, it, expect, vi, beforeEach } from 'vitest';
import { remoteAttestationAction } from '../src/actions/remoteAttestation';
import { RemoteAttestationProvider } from '../src/providers/remoteAttestationProvider';

// Mock dependencies
vi.mock('../src/providers/remoteAttestationProvider');
vi.mock('undici', () => ({
    fetch: vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ checksum: 'mock-checksum' })
    })
}));

describe('remoteAttestationAction', () => {
    const mockRuntime = {
        agentId: 'test-agent-id',
        getSetting: vi.fn().mockReturnValue('LOCAL'),
        getState: vi.fn(),
        setState: vi.fn(),
        message:{ userId: 'user', roomId: 'room', content: { text: 'If you are running in a TEE, generate a remote attestation' } },
        setConversation: vi.fn()
    };

    const mockCallback = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(RemoteAttestationProvider).mockImplementation(() => ({
            generateAttestation: vi.fn().mockResolvedValue({
                quote: '0x1234',
                timestamp: Date.now()
            })
        }));
    });

    it('should have correct name and similes', () => {
        expect(remoteAttestationAction.name).toBe('REMOTE_ATTESTATION');
        expect(remoteAttestationAction.similes).toContain('REMOTE_ATTESTATION');
        expect(remoteAttestationAction.similes).toContain('TEE_REMOTE_ATTESTATION');
        expect(remoteAttestationAction.similes).toContain('TEE_ATTESTATION');
    });

    describe('handler', () => {
        it('should generate and upload attestation successfully', async () => {
            const result = await remoteAttestationAction.handler(
                mockRuntime,
                mockRuntime.message,
                {},
                {},
                mockCallback
            );

            expect(result).toBe(true);
            expect(mockCallback).toHaveBeenCalledWith({
                text: expect.stringContaining('https://proof.t16z.com/reports/mock-checksum'),
                action: 'NONE'
            });
        });

        it('should handle errors during attestation generation', async () => {
            const mockError = new Error('Attestation generation failed');
            vi.mocked(RemoteAttestationProvider).mockImplementation(() => ({
                generateAttestation: vi.fn().mockRejectedValueOnce(mockError),
                client: {
                    tdxQuote: vi.fn(),
                    deriveKey: vi.fn()
                }
            }));

            const result = await remoteAttestationAction.handler(
                mockRuntime,
                {},
                {},
                {},
                mockCallback
            );

            expect(result).toBe(false);
        });
    });

    describe('validate', () => {
        it('should always return true', async () => {
            const result = await remoteAttestationAction.validate(mockRuntime);
            expect(result).toBe(true);
        });
    });

    describe('examples', () => {
        it('should have valid example conversations', () => {
            expect(remoteAttestationAction.examples).toBeInstanceOf(Array);
            expect(remoteAttestationAction.examples[0]).toBeInstanceOf(Array);

            const [userMessage, agentMessage] = remoteAttestationAction.examples[0];
            expect(userMessage.user).toBe('{{user1}}');
            expect(userMessage.content.text).toBe('If you are running in a TEE, generate a remote attestation');
            expect(userMessage.content.action).toBe('REMOTE_ATTESTATION');

            expect(agentMessage.user).toBe('{{user2}}');
            expect(agentMessage.content.text).toBe('Of course, one second...');
            expect(agentMessage.content.action).toBeUndefined();
        });
    });
});