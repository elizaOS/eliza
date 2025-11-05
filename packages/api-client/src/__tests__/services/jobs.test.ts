import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { JobsService } from '../../services/jobs';
import { ApiClientConfig } from '../../types/base';
import { JobStatus } from '../../types/jobs';
import type { UUID } from '@elizaos/core';

describe('JobsService', () => {
    let jobsService: JobsService;
    const mockConfig: ApiClientConfig = {
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-key',
    };

    beforeEach(() => {
        jobsService = new JobsService(mockConfig);
        // Mock the HTTP methods
        (jobsService as any).get = mock(() => Promise.resolve({}));
        (jobsService as any).post = mock(() => Promise.resolve({}));
    });

    afterEach(() => {
        const getMock = (jobsService as any).get;
        const postMock = (jobsService as any).post;

        if (getMock?.mockClear) getMock.mockClear();
        if (postMock?.mockClear) postMock.mockClear();
    });

    describe('constructor', () => {
        it('should create an instance with valid configuration', () => {
            expect(jobsService).toBeInstanceOf(JobsService);
        });

        it('should throw error when initialized with invalid configuration', () => {
            expect(() => new JobsService(null as any)).toThrow();
        });
    });

    describe('create', () => {
        const mockParams = {
            userId: 'user-123' as UUID,
            content: 'What is Bitcoin?',
            agentId: 'agent-456' as UUID,
            metadata: { source: 'test' },
            timeoutMs: 60000,
        };

        it('should create a job successfully', async () => {
            const mockResponse = {
                jobId: 'job-789',
                status: JobStatus.PENDING,
                createdAt: Date.now(),
                expiresAt: Date.now() + 60000,
            };
            (jobsService as any).post.mockResolvedValue(mockResponse);

            const result = await jobsService.create(mockParams);

            expect((jobsService as any).post).toHaveBeenCalledWith('/api/messaging/jobs', mockParams);
            expect(result).toEqual(mockResponse);
        });

        it('should create a job without optional parameters', async () => {
            const minimalParams = {
                userId: 'user-123' as UUID,
                content: 'What is Bitcoin?',
            };

            const mockResponse = {
                jobId: 'job-789',
                status: JobStatus.PENDING,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
            };
            (jobsService as any).post.mockResolvedValue(mockResponse);

            const result = await jobsService.create(minimalParams);

            expect((jobsService as any).post).toHaveBeenCalledWith('/api/messaging/jobs', minimalParams);
            expect(result).toEqual(mockResponse);
        });

        it('should handle creation errors', async () => {
            (jobsService as any).post.mockRejectedValue(new Error('Job creation failed'));

            await expect(jobsService.create(mockParams)).rejects.toThrow('Job creation failed');
        });
    });

    describe('getJob', () => {
        const jobId = 'job-123';

        it('should get job details successfully', async () => {
            const mockResponse = {
                jobId,
                status: JobStatus.COMPLETED,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now() - 5000,
                expiresAt: Date.now() + 25000,
                result: {
                    message: {
                        id: 'msg-789' as UUID,
                        content: 'Bitcoin is a cryptocurrency...',
                        authorId: 'agent-456' as UUID,
                        createdAt: Date.now(),
                    },
                    processingTimeMs: 4500,
                },
            };
            (jobsService as any).get.mockResolvedValue(mockResponse);

            const result = await jobsService.getJob(jobId);

            expect((jobsService as any).get).toHaveBeenCalledWith(`/api/messaging/jobs/${jobId}`);
            expect(result).toEqual(mockResponse);
        });

        it('should get pending job', async () => {
            const mockResponse = {
                jobId,
                status: JobStatus.PROCESSING,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now() - 1000,
                expiresAt: Date.now() + 29000,
            };
            (jobsService as any).get.mockResolvedValue(mockResponse);

            const result = await jobsService.getJob(jobId);

            expect(result.status).toBe(JobStatus.PROCESSING);
            expect(result.result).toBeUndefined();
        });

        it('should get failed job with error', async () => {
            const mockResponse = {
                jobId,
                status: JobStatus.FAILED,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now() - 1000,
                expiresAt: Date.now() + 29000,
                error: 'Agent not available',
            };
            (jobsService as any).get.mockResolvedValue(mockResponse);

            const result = await jobsService.getJob(jobId);

            expect(result.status).toBe(JobStatus.FAILED);
            expect(result.error).toBe('Agent not available');
        });
    });

    describe('list', () => {
        it('should list all jobs', async () => {
            const mockResponse = {
                jobs: [
                    {
                        jobId: 'job-1',
                        status: JobStatus.COMPLETED,
                        agentId: 'agent-1' as UUID,
                        userId: 'user-1' as UUID,
                        prompt: 'Question 1',
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 30000,
                    },
                    {
                        jobId: 'job-2',
                        status: JobStatus.PROCESSING,
                        agentId: 'agent-1' as UUID,
                        userId: 'user-1' as UUID,
                        prompt: 'Question 2',
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 30000,
                    },
                ],
                total: 2,
                filtered: 2,
            };
            (jobsService as any).get.mockResolvedValue(mockResponse);

            const result = await jobsService.list();

            expect((jobsService as any).get).toHaveBeenCalledWith('/api/messaging/jobs', { params: undefined });
            expect(result).toEqual(mockResponse);
        });

        it('should list jobs with status filter', async () => {
            const mockResponse = {
                jobs: [
                    {
                        jobId: 'job-1',
                        status: JobStatus.COMPLETED,
                        agentId: 'agent-1' as UUID,
                        userId: 'user-1' as UUID,
                        prompt: 'Question 1',
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 30000,
                    },
                ],
                total: 10,
                filtered: 1,
            };
            (jobsService as any).get.mockResolvedValue(mockResponse);

            const result = await jobsService.list({ status: JobStatus.COMPLETED, limit: 10 });

            expect((jobsService as any).get).toHaveBeenCalledWith('/api/messaging/jobs', {
                params: { status: JobStatus.COMPLETED, limit: 10 },
            });
            expect(result).toEqual(mockResponse);
        });
    });

    describe('health', () => {
        it('should get health status successfully', async () => {
            const mockResponse = {
                healthy: true,
                timestamp: Date.now(),
                totalJobs: 100,
                statusCounts: {
                    pending: 5,
                    processing: 10,
                    completed: 75,
                    failed: 8,
                    timeout: 2,
                },
                metrics: {
                    averageProcessingTimeMs: 3500,
                    successRate: 0.75,
                    failureRate: 0.08,
                    timeoutRate: 0.02,
                },
                maxJobs: 10000,
            };
            (jobsService as any).get.mockResolvedValue(mockResponse);

            const result = await jobsService.health();

            expect((jobsService as any).get).toHaveBeenCalledWith('/api/messaging/jobs/health');
            expect(result).toEqual(mockResponse);
        });
    });

    describe('poll', () => {
        const jobId = 'job-123';

        it('should poll until job completes', async () => {
            const completedJob = {
                jobId,
                status: JobStatus.COMPLETED,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now() - 2000,
                expiresAt: Date.now() + 28000,
                result: {
                    message: {
                        id: 'msg-789' as UUID,
                        content: 'Bitcoin is a cryptocurrency...',
                        authorId: 'agent-456' as UUID,
                        createdAt: Date.now(),
                    },
                    processingTimeMs: 1500,
                },
            };

            let callCount = 0;
            (jobsService as any).get.mockImplementation(() => {
                callCount++;
                if (callCount < 3) {
                    return Promise.resolve({
                        ...completedJob,
                        status: JobStatus.PROCESSING,
                        result: undefined,
                    });
                }
                return Promise.resolve(completedJob);
            });

            const result = await jobsService.poll(jobId, { interval: 10 });

            expect(result.success).toBe(true);
            expect(result.job.status).toBe(JobStatus.COMPLETED);
            expect(result.attempts).toBe(3);
        });

        it('should handle failed jobs', async () => {
            const failedJob = {
                jobId,
                status: JobStatus.FAILED,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now() - 1000,
                expiresAt: Date.now() + 29000,
                error: 'Agent error',
            };

            (jobsService as any).get.mockResolvedValue(failedJob);

            const result = await jobsService.poll(jobId, { interval: 10 });

            expect(result.success).toBe(false);
            expect(result.job.status).toBe(JobStatus.FAILED);
            expect(result.job.error).toBe('Agent error');
        });

        it('should handle timeout jobs', async () => {
            const timeoutJob = {
                jobId,
                status: JobStatus.TIMEOUT,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now() - 31000,
                expiresAt: Date.now() - 1000,
                error: 'Job timed out',
            };

            (jobsService as any).get.mockResolvedValue(timeoutJob);

            const result = await jobsService.poll(jobId, { interval: 10 });

            expect(result.success).toBe(false);
            expect(result.job.status).toBe(JobStatus.TIMEOUT);
        });

        it('should respect maxAttempts', async () => {
            const processingJob = {
                jobId,
                status: JobStatus.PROCESSING,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
            };

            (jobsService as any).get.mockResolvedValue(processingJob);

            const result = await jobsService.poll(jobId, {
                interval: 10,
                maxAttempts: 5,
            });

            expect(result.success).toBe(false);
            expect(result.attempts).toBe(5);
        });

        it('should call onProgress callback', async () => {
            const completedJob = {
                jobId,
                status: JobStatus.COMPLETED,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
                result: {
                    message: {
                        id: 'msg-789' as UUID,
                        content: 'Bitcoin is a cryptocurrency...',
                        authorId: 'agent-456' as UUID,
                        createdAt: Date.now(),
                    },
                    processingTimeMs: 500,
                },
            };

            (jobsService as any).get.mockResolvedValue(completedJob);

            const onProgress = mock(() => { });

            await jobsService.poll(jobId, {
                interval: 10,
                onProgress,
            });

            expect(onProgress).toHaveBeenCalled();
        });
    });

    describe('createAndPoll', () => {
        const mockParams = {
            userId: 'user-123' as UUID,
            content: 'What is Bitcoin?',
        };

        it('should create and poll job successfully', async () => {
            const createResponse = {
                jobId: 'job-789',
                status: JobStatus.PENDING,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
            };

            const completedJob = {
                jobId: 'job-789',
                status: JobStatus.COMPLETED,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
                result: {
                    message: {
                        id: 'msg-789' as UUID,
                        content: 'Bitcoin is a cryptocurrency...',
                        authorId: 'agent-456' as UUID,
                        createdAt: Date.now(),
                    },
                    processingTimeMs: 500,
                },
            };

            (jobsService as any).post.mockResolvedValue(createResponse);
            (jobsService as any).get.mockResolvedValue(completedJob);

            const result = await jobsService.createAndPoll(mockParams, { interval: 10 });

            expect(result.success).toBe(true);
            expect(result.job.status).toBe(JobStatus.COMPLETED);
        });
    });

    describe('createAndPollWithBackoff', () => {
        const mockParams = {
            userId: 'user-123' as UUID,
            content: 'What is Bitcoin?',
        };

        it('should create and poll with exponential backoff', async () => {
            const createResponse = {
                jobId: 'job-789',
                status: JobStatus.PENDING,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
            };

            const completedJob = {
                jobId: 'job-789',
                status: JobStatus.COMPLETED,
                agentId: 'agent-456' as UUID,
                userId: 'user-123' as UUID,
                prompt: 'What is Bitcoin?',
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
                result: {
                    message: {
                        id: 'msg-789' as UUID,
                        content: 'Bitcoin is a cryptocurrency...',
                        authorId: 'agent-456' as UUID,
                        createdAt: Date.now(),
                    },
                    processingTimeMs: 500,
                },
            };

            let callCount = 0;
            (jobsService as any).post.mockResolvedValue(createResponse);
            (jobsService as any).get.mockImplementation(() => {
                callCount++;
                if (callCount < 3) {
                    return Promise.resolve({
                        ...completedJob,
                        status: JobStatus.PROCESSING,
                        result: undefined,
                    });
                }
                return Promise.resolve(completedJob);
            });

            const result = await jobsService.createAndPollWithBackoff(mockParams, {
                initialInterval: 10,
                maxInterval: 100,
                multiplier: 2,
            });

            expect(result.success).toBe(true);
            expect(result.job.status).toBe(JobStatus.COMPLETED);
            expect(callCount).toBe(3);
        });
    });

    describe('ask', () => {
        const userId = 'user-123' as UUID;
        const content = 'What is Bitcoin?';

        it('should ask question and get response', async () => {
            const createResponse = {
                jobId: 'job-789',
                status: JobStatus.PENDING,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
            };

            const completedJob = {
                jobId: 'job-789',
                status: JobStatus.COMPLETED,
                agentId: 'agent-456' as UUID,
                userId,
                prompt: content,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
                result: {
                    message: {
                        id: 'msg-789' as UUID,
                        content: 'Bitcoin is a cryptocurrency...',
                        authorId: 'agent-456' as UUID,
                        createdAt: Date.now(),
                    },
                    processingTimeMs: 500,
                },
            };

            (jobsService as any).post.mockResolvedValue(createResponse);
            (jobsService as any).get.mockResolvedValue(completedJob);

            const response = await jobsService.ask(userId, content);

            expect(response).toBe('Bitcoin is a cryptocurrency...');
        });

        it('should throw error on failed job', async () => {
            const createResponse = {
                jobId: 'job-789',
                status: JobStatus.PENDING,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
            };

            const failedJob = {
                jobId: 'job-789',
                status: JobStatus.FAILED,
                agentId: 'agent-456' as UUID,
                userId,
                prompt: content,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
                error: 'Agent error',
            };

            (jobsService as any).post.mockResolvedValue(createResponse);
            (jobsService as any).get.mockResolvedValue(failedJob);

            await expect(jobsService.ask(userId, content)).rejects.toThrow('Agent error');
        });

        it('should throw error on timeout', async () => {
            const createResponse = {
                jobId: 'job-789',
                status: JobStatus.PENDING,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
            };

            const timeoutJob = {
                jobId: 'job-789',
                status: JobStatus.TIMEOUT,
                agentId: 'agent-456' as UUID,
                userId,
                prompt: content,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
                error: 'Job timed out',
            };

            (jobsService as any).post.mockResolvedValue(createResponse);
            (jobsService as any).get.mockResolvedValue(timeoutJob);

            await expect(jobsService.ask(userId, content)).rejects.toThrow();
        });
    });

    describe('error handling', () => {
        it('should handle network errors', async () => {
            (jobsService as any).get.mockRejectedValue(new Error('Network error'));

            await expect(jobsService.health()).rejects.toThrow('Network error');
        });

        it('should handle API errors', async () => {
            (jobsService as any).post.mockRejectedValue(new Error('API error'));

            const params = {
                userId: 'user-123' as UUID,
                content: 'What is Bitcoin?',
            };

            await expect(jobsService.create(params)).rejects.toThrow('API error');
        });
    });
});

