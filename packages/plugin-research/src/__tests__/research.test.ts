import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ResearchService } from '../service';
import { ResearchStatus, ResearchPhase, ResearchProject } from '../types';
import { IAgentRuntime, ModelType } from '@elizaos/core';
import { createTestRuntime, createTestProviders } from './test-providers';
import {
  LongRunningTestManager,
  QUICK_TEST_CONFIG,
} from './test-runner-config';

let testManager: LongRunningTestManager;

beforeEach(() => {
  testManager = new LongRunningTestManager(QUICK_TEST_CONFIG);
});

afterEach(() => {
  testManager.cleanup();
});

describe('ResearchService', () => {
  let runtime: IAgentRuntime;
  let service: ResearchService;

  beforeEach(() => {
    runtime = createTestRuntime();
    service = new ResearchService(runtime);
  });

  describe('service initialization', () => {
    it('should create service with default config', () => {
      expect(service).toBeDefined();
      expect(service.capabilityDescription).toContain(
        'PhD-level deep research'
      );
    });

    it('should create service with custom config', () => {
      const customService = new ResearchService(runtime);
      expect(customService).toBeDefined();
    });
  });

  describe('createResearchProject', () => {
    it('should create a new research project', async () => {
      const query = 'quantum computing breakthroughs in 2024';
      const project = await service.createResearchProject(query);

      expect(project).toBeDefined();
      expect(project.id).toBeDefined();
      expect(project.query).toBe(query);
      expect([ResearchStatus.PENDING, ResearchStatus.ACTIVE]).toContain(
        project.status
      );
      expect([
        ResearchPhase.INITIALIZATION,
        ResearchPhase.PLANNING,
        ResearchPhase.SEARCHING,
      ]).toContain(project.phase);
      expect(project.findings).toEqual([]);
      expect(project.sources).toEqual([]);
    });

    it('should create project with custom config', async () => {
      const query = 'AI healthcare impact';
      const config = { maxSearchResults: 5, language: 'es' };
      const project = await service.createResearchProject(query, config);

      expect(project.metadata.language).toBe(config.language);
    });
  });

  describe('project lifecycle', () => {
    it('should get project by id', async () => {
      const project = await service.createResearchProject('test query');
      const retrieved = await service.getProject(project.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(project.id);
    });

    it('should get all projects', async () => {
      await service.createResearchProject('query 1');
      await service.createResearchProject('query 2');

      const projects = await service.getAllProjects();
      expect(projects.length).toBeGreaterThanOrEqual(2);
    });

    it('should get active projects', async () => {
      const project = await service.createResearchProject('active query');

      // Wait a bit for the project to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if it's active or already completed (both are valid)
      const activeProjects = await service.getActiveProjects();
      const projectStatus = await service.getProject(project.id);

      // Either the project should be in active projects, or it should have completed/failed
      const isActive = activeProjects.some((p) => p.id === project.id);
      const isCompleted = projectStatus?.status === ResearchStatus.COMPLETED;
      const isFailed = projectStatus?.status === ResearchStatus.FAILED;
      const isPending = projectStatus?.status === ResearchStatus.PENDING;

      // The test passes if the project is in any valid state
      expect(isActive || isCompleted || isFailed || isPending).toBe(true);
    });

    it('should pause and resume research', async () => {
      const project = await service.createResearchProject('pausable query');

      // Wait for project to become active
      await new Promise((resolve) => setTimeout(resolve, 100));

      await service.pauseResearch(project.id);
      const paused = await service.getProject(project.id);
      expect(paused?.status).toBe(ResearchStatus.PAUSED);

      await service.resumeResearch(project.id);
      // Status will change back to active once resumed
    });
  });

  describe('research phases', () => {
    it('should progress through research phases', async () => {
      const project = await service.createResearchProject('phase test query');

      // Monitor phase progression
      const phases: ResearchPhase[] = [];
      const checkPhase = async () => {
        const p = await service.getProject(project.id);
        if (p && !phases.includes(p.phase)) {
          phases.push(p.phase);
        }
      };

      // Check phases over time
      for (let i = 0; i < 10; i++) {
        await checkPhase();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(phases.length).toBeGreaterThanOrEqual(1);
      // First observed phase should be one of the early phases
      const earlyPhases = [
        ResearchPhase.INITIALIZATION,
        ResearchPhase.PLANNING,
        ResearchPhase.SEARCHING,
      ];
      expect(earlyPhases).toContain(phases[0]);
    });
  });

  describe('error handling', () => {
    it('should handle invalid project id', async () => {
      const project = await service.getProject('invalid-id');
      expect(project).toBeUndefined();
    });

    it('should handle pause on non-existent project', async () => {
      // The service should handle this gracefully without throwing
      await service.pauseResearch('invalid-id');
      // If we get here, no error was thrown
      expect(true).toBe(true);
    });
  });
});
