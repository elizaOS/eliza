import { elizaLogger, IAgentRuntime, ModelType, Service } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { ResearchEvaluator } from './evaluation/research-evaluator';
import { SearchResultProcessor } from './processing/result-processor';
import { RelevanceAnalyzer } from './processing/relevance-analyzer';
import { ResearchLogger } from './processing/research-logger';
import {
  ContentExtractor,
  createContentExtractor,
  createSearchProvider,
  SearchProvider,
} from './integrations';
import { createAcademicSearchProvider } from './integrations/factory';
import { PDFExtractor } from './integrations/content-extractors/pdf-extractor';
import {
  EvaluationCriteriaGenerator,
  QueryPlanner,
  ResearchStrategyFactory,
} from './strategies/research-strategies';
import {
  BibliographyEntry,
  Citation,
  DeepResearchBenchResult,
  EvaluationMetrics,
  EvaluationResults,
  FactualClaim,
  IterationRecord,
  PerformanceMetrics,
  PhaseTiming,
  ReportSection,
  ResearchConfig,
  ResearchDepth,
  ResearchDomain,
  ResearchFinding,
  ResearchMetadata,
  ResearchPhase,
  ResearchProgress,
  ResearchProject,
  ResearchSource,
  ResearchStatus,
  SearchResult,
  SourceType,
  TaskType,
  VerificationStatus,
} from './types';
import fs from 'fs/promises';
import path from 'path';
import { ClaimVerifier } from './verification/claim-verifier';
import { RESEARCH_PROMPTS, formatPrompt, getPromptConfig } from './prompts/research-prompts';
import {
  loadResearchConfig,
  validateSearchProviderConfig,
  getConfigSummary,
} from './config/research-config';

// Factory for creating search providers and content extractors
class SearchProviderFactory {
  private pdfExtractor: PDFExtractor;

  constructor(private runtime: IAgentRuntime) {
    this.pdfExtractor = new PDFExtractor();
  }

  getProvider(type: string): SearchProvider {
    // IMPORTANT: Always create fresh instances to avoid cross-contamination between projects
    // Each call creates a new provider instance with its own cache
    if (type === 'academic') {
      return createAcademicSearchProvider(this.runtime);
    }

    const provider = createSearchProvider(type, this.runtime);
    if (!provider) {
      throw new Error('No search provider available');
    }
    return provider;
  }

  getContentExtractor(): ContentExtractor {
    const extractor = createContentExtractor(this.runtime);
    if (!extractor) {
      throw new Error('No content extractor available');
    }
    return extractor;
  }

  getPDFExtractor(): PDFExtractor {
    return this.pdfExtractor;
  }
}

// Configuration is now loaded dynamically from runtime settings
// See src/config/research-config.ts for configuration management

export class ResearchService extends Service {
  private projects: Map<string, ResearchProject> = new Map();
  private activeResearch: Map<string, AbortController> = new Map();
  private searchProviderFactory: SearchProviderFactory;
  private queryPlanner: QueryPlanner;
  private strategyFactory: ResearchStrategyFactory;
  private criteriaGenerator: EvaluationCriteriaGenerator;
  private evaluator: ResearchEvaluator;
  private resultProcessor: SearchResultProcessor;
  private relevanceAnalyzer: RelevanceAnalyzer;
  private researchLogger: ResearchLogger;
  private performanceData: Map<string, PerformanceMetrics> = new Map();
  private claimVerifier: ClaimVerifier;
  private researchConfig: ResearchConfig;

  static serviceName = 'research';
  static serviceType = 'research';
  public serviceName = 'research';

  static async start(runtime: IAgentRuntime) {
    const service = new ResearchService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    const service = new ResearchService(runtime);
    await service.stop();
  }

  public capabilityDescription =
    'PhD-level deep research across 22 domains with RACE/FACT evaluation';

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;

    // Load and validate configuration
    this.researchConfig = loadResearchConfig(runtime);
    validateSearchProviderConfig(this.researchConfig, runtime);

    elizaLogger.info(
      '[ResearchService] Initializing with configuration:',
      getConfigSummary(this.researchConfig)
    );

    this.searchProviderFactory = new SearchProviderFactory(runtime);
    this.queryPlanner = new QueryPlanner(runtime);
    this.strategyFactory = new ResearchStrategyFactory(runtime);
    this.criteriaGenerator = new EvaluationCriteriaGenerator(runtime);
    this.evaluator = new ResearchEvaluator(runtime);
    this.relevanceAnalyzer = new RelevanceAnalyzer(runtime);
    this.researchLogger = new ResearchLogger(runtime);
    this.resultProcessor = new SearchResultProcessor({
      qualityThreshold: this.researchConfig.qualityThreshold * 0.6, // Slightly lower for initial filtering
      deduplicationThreshold: 0.85,
      maxResults: this.researchConfig.maxSearchResults,
      prioritizeRecent: true,
      diversityWeight: 0.3,
    });
    this.claimVerifier = new ClaimVerifier(
      runtime,
      this.searchProviderFactory.getContentExtractor()
    );
  }

  async createResearchProject(
    query: string,
    config?: Partial<ResearchConfig>
  ): Promise<ResearchProject> {
    const projectId = uuidv4();
    const baseConfig = loadResearchConfig(this.runtime);
    const mergedConfig = { ...baseConfig, ...config };

    // Always use full research pipeline for best quality
    elizaLogger.info(`[ResearchService] Starting comprehensive research for: ${query}`);

    // Extract metadata from query
    const metadata = await this.extractMetadata(query, mergedConfig);

    const project: ResearchProject = {
      id: projectId,
      query,
      status: ResearchStatus.PENDING,
      phase: ResearchPhase.INITIALIZATION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      findings: [],
      sources: [],
      metadata,
    };

    this.projects.set(projectId, project);

    // Start research asynchronously
    this.startResearch(projectId, mergedConfig).catch((error) => {
      elizaLogger.error(`Research failed for project ${projectId}:`, error);
      project.status = ResearchStatus.FAILED;
      project.error = error.message;
    });

    return project;
  }

  private async extractMetadata(query: string, config: ResearchConfig): Promise<ResearchMetadata> {
    // Extract domain if not provided
    const domain = config.domain || (await this.extractDomain(query));

    // Extract task type
    const taskType = await this.extractTaskType(query);

    // Select appropriate search providers based on domain and query
    const selectedProviders = this.selectSearchProviders(domain, query);

    // Update config with domain-specific providers (merge with user-specified ones)
    const searchProviders = this.researchConfig.searchProviders?.length
      ? [...new Set([...this.researchConfig.searchProviders, ...selectedProviders])]
      : selectedProviders;

    // Update the config object for use in research
    this.researchConfig.searchProviders = searchProviders;

    elizaLogger.info(
      `[ResearchService] Domain: ${domain}, Selected providers: ${searchProviders.join(', ')}`
    );

    // Create query plan
    const queryPlan = await this.queryPlanner.createQueryPlan(query, {
      domain,
      taskType,
      depth: config.researchDepth,
    });

    // Generate evaluation criteria
    const evaluationCriteria = await this.criteriaGenerator.generateCriteria(query, domain);

    // Initialize performance metrics
    const performanceMetrics: PerformanceMetrics = {
      totalDuration: 0,
      phaseBreakdown: {} as Record<ResearchPhase, PhaseTiming>,
      searchQueries: 0,
      sourcesProcessed: 0,
      tokensGenerated: 0,
      cacheHits: 0,
      parallelOperations: 0,
    };

    return {
      domain,
      taskType,
      language: config.language,
      depth: config.researchDepth,
      queryPlan,
      evaluationCriteria,
      iterationHistory: [],
      performanceMetrics,
    };
  }

  private async extractDomain(query: string): Promise<ResearchDomain> {
    // Use embeddings-based classification for more accurate domain detection
    try {
      if (this.runtime.useModel) {
        // Create domain examples for similarity matching
        const domainExamples = {
          [ResearchDomain.PHYSICS]: [
            'quantum mechanics and particle physics research',
            'theoretical physics and relativity studies',
            'condensed matter physics and thermodynamics',
          ],
          [ResearchDomain.COMPUTER_SCIENCE]: [
            'machine learning and artificial intelligence',
            'software engineering and programming languages',
            'algorithms and data structures research',
          ],
          [ResearchDomain.BIOLOGY]: [
            'molecular biology and genetics research',
            'cell biology and biochemistry studies',
            'evolutionary biology and ecology',
          ],
          [ResearchDomain.MEDICINE]: [
            'clinical medicine and patient treatment',
            'medical research and drug development',
            'healthcare and disease management',
          ],
          [ResearchDomain.CHEMISTRY]: [
            'organic chemistry and synthesis',
            'analytical chemistry and spectroscopy',
            'physical chemistry and materials',
          ],
          [ResearchDomain.PSYCHOLOGY]: [
            'cognitive psychology and behavior',
            'clinical psychology and mental health',
            'social psychology and human behavior',
          ],
          [ResearchDomain.ECONOMICS]: [
            'economic theory and market analysis',
            'finance and monetary policy',
            'economic development and trade',
          ],
          [ResearchDomain.POLITICS]: [
            'political theory and governance',
            'international relations and diplomacy',
            'public policy and administration',
          ],
        };

        // Get query embedding
        const queryEmbedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
          text: query,
        });

        let bestDomain = ResearchDomain.GENERAL;
        let bestSimilarity = 0;

        // Compare with domain examples
        for (const [domain, examples] of Object.entries(domainExamples)) {
          for (const example of examples) {
            try {
              const exampleEmbedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
                text: example,
              });

              // Calculate cosine similarity
              const similarity = this.calculateCosineSimilarity(
                queryEmbedding as number[],
                exampleEmbedding as number[]
              );

              if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                bestDomain = domain as ResearchDomain;
              }
            } catch (error) {
              elizaLogger.debug(
                `Error processing domain example: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        }

        // If similarity is high enough, use embedding-based classification
        if (bestSimilarity > 0.7) {
          elizaLogger.info(
            `Domain classified via embeddings: ${bestDomain} (similarity: ${bestSimilarity.toFixed(3)})`
          );
          return bestDomain;
        }
      }
    } catch (error) {
      elizaLogger.warn(
        'Error using embeddings for domain classification, falling back to LLM:',
        error
      );
    }

    // Fallback: Use LLM classification
    if (this.runtime.useModel) {
      const prompt = `Analyze this research query and determine the most appropriate research domain.

Query: "${query}"

Available domains:
${Object.values(ResearchDomain)
  .map((d) => `- ${d}`)
  .join('\n')}

Consider:
- Primary subject matter and field of study
- Methodology and approach
- Target audience and applications
- Interdisciplinary connections

Respond with ONLY the domain name from the list above. Be precise.`;

      try {
        const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
          messages: [
            {
              role: 'system',
              content:
                'You are an expert research domain classifier. Analyze the query and respond with only the most appropriate domain name from the provided list.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1, // Low temperature for consistent classification
        });

        const domainText = (
          typeof response === 'string' ? response : (response as any).content || ''
        )
          .trim()
          .toLowerCase();

        // Exact match first
        for (const domain of Object.values(ResearchDomain)) {
          if (domainText === domain.toLowerCase()) {
            elizaLogger.info(`Domain classified via LLM: ${domain}`);
            return domain as ResearchDomain;
          }
        }

        // Partial match fallback
        for (const domain of Object.values(ResearchDomain)) {
          if (
            domainText.includes(domain.toLowerCase().replace('_', ' ')) ||
            domainText.includes(domain.toLowerCase().replace('_', ''))
          ) {
            elizaLogger.info(`Domain classified via LLM (partial match): ${domain}`);
            return domain as ResearchDomain;
          }
        }

        elizaLogger.warn(`Could not extract domain from LLM response: ${domainText}`);
      } catch (error) {
        elizaLogger.warn(
          'Error using LLM for domain extraction, falling back to heuristics:',
          error
        );
      }
    }

    // Final fallback: Simple keyword matching
    const lowerQuery = query.toLowerCase();
    const keywords = {
      [ResearchDomain.PHYSICS]: ['quantum', 'physics', 'particle', 'relativity', 'thermodynamics'],
      [ResearchDomain.COMPUTER_SCIENCE]: [
        'computer',
        'software',
        'algorithm',
        'programming',
        'ai',
        'artificial intelligence',
        'machine learning',
      ],
      [ResearchDomain.BIOLOGY]: ['biology', 'gene', 'cell', 'dna', 'evolution', 'organism'],
      [ResearchDomain.MEDICINE]: [
        'medicine',
        'health',
        'disease',
        'treatment',
        'clinical',
        'medical',
      ],
      [ResearchDomain.CHEMISTRY]: ['chemistry', 'chemical', 'molecule', 'synthesis', 'compound'],
      [ResearchDomain.PSYCHOLOGY]: ['psychology', 'mental', 'behavior', 'cognitive', 'brain'],
      [ResearchDomain.ECONOMICS]: ['economic', 'finance', 'market', 'currency', 'trade'],
      [ResearchDomain.POLITICS]: ['political', 'government', 'policy', 'politics', 'governance'],
    };

    for (const [domain, words] of Object.entries(keywords)) {
      if (words.some((word) => lowerQuery.includes(word))) {
        elizaLogger.info(`Domain classified via keywords: ${domain}`);
        return domain as ResearchDomain;
      }
    }

    elizaLogger.info('Domain classified as GENERAL (no specific match found)');
    return ResearchDomain.GENERAL;
  }

  private calculateCosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  private selectSearchProviders(domain: ResearchDomain, query: string): string[] {
    const queryLower = query.toLowerCase();
    const providers = new Set<string>();

    // Analyze query intent for intelligent source selection
    const isCodeRelated = this.isCodeRelatedQuery(queryLower);
    const isAcademicQuery = this.isAcademicQuery(queryLower);
    const isTechnicalDocumentation = this.isTechnicalDocumentationQuery(queryLower);

    elizaLogger.info(
      `[ProviderSelection] Query analysis - Code: ${isCodeRelated}, Academic: ${isAcademicQuery}, TechDocs: ${isTechnicalDocumentation}`
    );

    // Always include web search as base (prioritizes Tavily per user request)
    providers.add('web');

    // CODING PROBLEMS: Focus on technical sources, avoid academic noise
    if (isCodeRelated) {
      elizaLogger.info(
        '[ProviderSelection] Code-related query detected - prioritizing technical sources'
      );
      providers.add('github');

      // Add specific package managers based on language detection
      if (queryLower.match(/(python|django|flask|fastapi|pip|pypi)/)) {
        providers.add('pypi');
      }
      if (queryLower.match(/(javascript|typescript|react|node|npm|yarn)/)) {
        providers.add('npm');
      }

      // Only add academic for computer science theory/algorithms
      if (queryLower.match(/(algorithm|complexity|theory|research)/)) {
        providers.add('academic');
      }

      return Array.from(providers);
    }

    // ACADEMIC RESEARCH: Full academic source access
    if (isAcademicQuery || this.isAcademicDomain(domain)) {
      elizaLogger.info('[ProviderSelection] Academic query detected - including scholarly sources');
      providers.add('academic');
    }

    // TECHNICAL DOCUMENTATION: Focus on official docs and GitHub
    if (isTechnicalDocumentation) {
      elizaLogger.info('[ProviderSelection] Technical documentation query detected');
      providers.add('github');
    }

    // Domain-specific provider selection
    switch (domain) {
      case ResearchDomain.COMPUTER_SCIENCE:
      case ResearchDomain.ENGINEERING:
        if (!isCodeRelated) {
          // Academic CS research
          providers.add('academic');
          providers.add('github');
        }
        break;

      case ResearchDomain.PHYSICS:
      case ResearchDomain.CHEMISTRY:
      case ResearchDomain.BIOLOGY:
      case ResearchDomain.MEDICINE:
      case ResearchDomain.MATHEMATICS:
        providers.add('academic');
        break;

      case ResearchDomain.ECONOMICS:
      case ResearchDomain.POLITICS:
      case ResearchDomain.PSYCHOLOGY:
      case ResearchDomain.SOCIOLOGY:
        providers.add('academic');
        break;

      default:
        // For general queries, be selective about academic sources
        if (isAcademicQuery) {
          providers.add('academic');
        }

        // Add technical sources for any tech-related general queries
        if (queryLower.match(/(technology|software|programming|development)/)) {
          providers.add('github');
        }
        break;
    }

    const selectedProviders = Array.from(providers);
    elizaLogger.info(`[ProviderSelection] Selected providers: ${selectedProviders.join(', ')}`);

    return selectedProviders;
  }

  private isCodeRelatedQuery(query: string): boolean {
    const codeIndicators = [
      // Direct code/programming terms
      'fix bug',
      'bug fix',
      'debug',
      'error',
      'exception',
      'implement',
      'code',
      'function',
      'method',
      'class',
      'variable',
      'syntax',
      'compile',
      'runtime',

      // Framework/library specific
      'react',
      'angular',
      'vue',
      'express',
      'django',
      'flask',
      'spring',
      'laravel',
      'rails',

      // Language specific
      'javascript',
      'typescript',
      'python',
      'java',
      'c++',
      'c#',
      'go',
      'rust',
      'php',

      // Development concepts
      'api',
      'endpoint',
      'middleware',
      'component',
      'hook',
      'props',
      'state',
      'async',
      'await',
      'promise',
      'callback',
      'event handler',

      // Issue/problem specific
      'not working',
      'failing',
      'broken',
      'issue #',
      'stack overflow',
      'type error',
      'reference error',
      'memory leak',
      'performance issue',
    ];

    return codeIndicators.some((indicator) => query.includes(indicator));
  }

  private isAcademicQuery(query: string): boolean {
    const academicIndicators = [
      'research',
      'study',
      'analysis',
      'theory',
      'hypothesis',
      'methodology',
      'literature review',
      'peer reviewed',
      'citation',
      'academic',
      'scholarly',
      'journal',
      'publication',
      'experiment',
      'empirical',
      'statistical',
      'correlation',
      'causation',
      'meta-analysis',
    ];

    return academicIndicators.some((indicator) => query.includes(indicator));
  }

  private isTechnicalDocumentationQuery(query: string): boolean {
    const docIndicators = [
      'documentation',
      'docs',
      'manual',
      'guide',
      'tutorial',
      'how to',
      'getting started',
      'installation',
      'setup',
      'configuration',
      'reference',
      'specification',
      'api docs',
    ];

    return docIndicators.some((indicator) => query.includes(indicator));
  }

  private isAcademicDomain(domain: ResearchDomain): boolean {
    const academicDomains = [
      ResearchDomain.PHYSICS,
      ResearchDomain.CHEMISTRY,
      ResearchDomain.BIOLOGY,
      ResearchDomain.MEDICINE,
      ResearchDomain.MATHEMATICS,
      ResearchDomain.PSYCHOLOGY,
      ResearchDomain.SOCIOLOGY,
      ResearchDomain.ECONOMICS,
      ResearchDomain.POLITICS,
      ResearchDomain.PHILOSOPHY,
      ResearchDomain.NEUROSCIENCE,
    ];

    return academicDomains.includes(domain);
  }

  private async extractTaskType(query: string): Promise<TaskType> {
    // Simple heuristic-based task type extraction for testing
    const lowerQuery = query.toLowerCase();

    // Check for task type keywords
    if (
      lowerQuery.includes('compar') ||
      lowerQuery.includes('versus') ||
      lowerQuery.includes('vs')
    ) {
      return TaskType.COMPARATIVE;
    }
    if (
      lowerQuery.includes('analyz') ||
      lowerQuery.includes('analysis') ||
      lowerQuery.includes('examine')
    ) {
      return TaskType.ANALYTICAL;
    }
    if (
      lowerQuery.includes('synthes') ||
      lowerQuery.includes('combin') ||
      lowerQuery.includes('integrat')
    ) {
      return TaskType.SYNTHETIC;
    }
    if (
      lowerQuery.includes('evaluat') ||
      lowerQuery.includes('assess') ||
      lowerQuery.includes('judge')
    ) {
      return TaskType.EVALUATIVE;
    }
    if (
      lowerQuery.includes('predict') ||
      lowerQuery.includes('forecast') ||
      lowerQuery.includes('future')
    ) {
      return TaskType.PREDICTIVE;
    }

    // If we have a working runtime.useModel, use it for more accurate classification
    if (this.runtime.useModel) {
      const prompt = `Analyze this research query and determine the primary task type.

Query: "${query}"

Task Types:
- ${TaskType.EXPLORATORY}: General exploration of a topic
- ${TaskType.COMPARATIVE}: Comparing different items, approaches, or solutions
- ${TaskType.ANALYTICAL}: Deep analysis of a specific subject
- ${TaskType.SYNTHETIC}: Combining multiple perspectives or sources
- ${TaskType.EVALUATIVE}: Assessment or evaluation of something
- ${TaskType.PREDICTIVE}: Forecasting or predicting future trends

Respond with ONLY the task type (e.g., "analytical"). Be precise.`;

      try {
        const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
          messages: [
            {
              role: 'system',
              content:
                'You are a research task classifier. Respond with only the task type, nothing else.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
        });

        const taskText = (typeof response === 'string' ? response : (response as any).content || '')
          .trim()
          .toLowerCase();

        // Check for exact matches
        for (const taskType of Object.values(TaskType)) {
          if (taskText === taskType.toLowerCase()) {
            return taskType as TaskType;
          }
        }

        // Check for keyword matches
        if (taskText.includes('compar')) return TaskType.COMPARATIVE;
        if (taskText.includes('analy')) return TaskType.ANALYTICAL;
        if (taskText.includes('synth')) return TaskType.SYNTHETIC;
        if (taskText.includes('eval')) return TaskType.EVALUATIVE;
        if (taskText.includes('pred') || taskText.includes('forecast')) return TaskType.PREDICTIVE;

        // Check for test/mock responses
        if (taskText.includes('mock') || taskText.includes('test')) {
          return TaskType.EXPLORATORY; // Default for test environments
        }

        elizaLogger.warn(`Could not extract task type from response: ${taskText}`);
      } catch (error) {
        elizaLogger.warn(
          'Error using model for task type extraction, falling back to heuristics:',
          error
        );
      }
    }

    return TaskType.EXPLORATORY;
  }

  private async startResearch(projectId: string, config: ResearchConfig): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) return;

    const controller = new AbortController();
    this.activeResearch.set(projectId, controller);

    try {
      project.status = ResearchStatus.ACTIVE;
      const startTime = Date.now();

      // Phase 1: Planning and Relevance Analysis
      await this.updatePhase(project, ResearchPhase.PLANNING);

      // Analyze query for relevance criteria
      elizaLogger.info(`[ResearchService] Analyzing query relevance for: ${project.query}`);
      const queryAnalysis = await this.relevanceAnalyzer.analyzeQueryRelevance(project.query);

      // Initialize comprehensive logging
      await this.researchLogger.initializeSession(projectId, project.query, queryAnalysis);

      // Phase 2: Searching with Relevance Filtering
      await this.updatePhase(project, ResearchPhase.SEARCHING);
      await this.executeSearchWithRelevance(project, config, controller.signal, queryAnalysis);

      // Phase 3: Analyzing with Relevance Verification
      await this.updatePhase(project, ResearchPhase.ANALYZING);
      await this.analyzeFindingsWithRelevance(project, config, queryAnalysis);

      // Synthesize findings
      await this.updatePhase(project, ResearchPhase.SYNTHESIZING);
      await this.synthesizeFindings(project);

      // Generate report (before evaluation)
      await this.updatePhase(project, ResearchPhase.REPORTING);
      await this.generateReport(project);

      // Evaluate if configured (optional)
      if (config.evaluationEnabled) {
        try {
          await this.updatePhase(project, ResearchPhase.EVALUATING);
          await this.evaluateProject(project.id);
        } catch (evalError) {
          elizaLogger.warn(
            '[ResearchService] Evaluation failed, but research completed:',
            evalError
          );
          // Don't fail the entire research if evaluation fails
        }
      }

      // Verify query answering and finalize logging
      const queryAnswering = await this.relevanceAnalyzer.verifyQueryAnswering(
        project.findings,
        project.query
      );
      await this.researchLogger.finalizeSession(
        projectId,
        queryAnswering.gaps,
        queryAnswering.recommendations
      );

      // Complete
      await this.updatePhase(project, ResearchPhase.COMPLETE);
      project.status = ResearchStatus.COMPLETED;
      project.completedAt = Date.now();

      // Update performance metrics
      const totalDuration = Date.now() - startTime;
      if (project.metadata.performanceMetrics) {
        project.metadata.performanceMetrics.totalDuration = totalDuration;
      }

      // Log final summary
      elizaLogger.info(`[ResearchService] Research completed for project ${projectId}:`, {
        duration: totalDuration,
        sources: project.sources.length,
        findings: project.findings.length,
        relevantFindings: project.findings.filter((f) => f.relevance >= 0.7).length,
        queryAnswering: queryAnswering.coverage,
      });
    } catch (error) {
      if ((error as any).name === 'AbortError') {
        project.status = ResearchStatus.PAUSED;
      } else {
        project.status = ResearchStatus.FAILED;
        project.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      this.activeResearch.delete(projectId);
      project.updatedAt = Date.now();
    }
  }

  private deduplicateResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const unique: SearchResult[] = [];

    for (const result of results) {
      // Use URL as unique identifier
      if (!seen.has(result.url)) {
        seen.add(result.url);
        unique.push(result);
      }
    }

    // Sort by score descending
    return unique.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  private async updatePhase(project: ResearchProject, phase: ResearchPhase): Promise<void> {
    const previousPhase = project.phase;
    project.phase = phase;
    project.updatedAt = Date.now();

    // Update phase timing
    if (project.metadata.performanceMetrics) {
      const phaseKey = previousPhase;
      if (phaseKey && project.metadata.performanceMetrics.phaseBreakdown[phaseKey]) {
        project.metadata.performanceMetrics.phaseBreakdown[phaseKey].endTime = Date.now();
      }

      project.metadata.performanceMetrics.phaseBreakdown[phase] = {
        startTime: Date.now(),
        endTime: 0,
        duration: 0,
        retries: 0,
        errors: [],
      };
    }

    // Emit progress
    this.emitProgress(project, `Starting ${phase} phase`);
  }

  private async executeSearchWithRelevance(
    project: ResearchProject,
    config: ResearchConfig,
    signal: AbortSignal,
    queryAnalysis: any
  ): Promise<void> {
    const queryPlan = project.metadata.queryPlan;

    // Use multiple search providers for comprehensive coverage
    const isAcademicDomain = [
      ResearchDomain.PHYSICS,
      ResearchDomain.CHEMISTRY,
      ResearchDomain.BIOLOGY,
      ResearchDomain.MEDICINE,
      ResearchDomain.COMPUTER_SCIENCE,
      ResearchDomain.MATHEMATICS,
      ResearchDomain.ENGINEERING,
      ResearchDomain.PSYCHOLOGY,
    ].includes(project.metadata.domain);

    const allResults: SearchResult[] = [];

    // Always search web sources with relevance scoring
    const webProvider = this.searchProviderFactory.getProvider('web');
    const webResults = await webProvider.search(queryPlan.mainQuery, config.maxSearchResults);
    allResults.push(...webResults);

    // Also search academic sources if configured or if academic domain
    if (config.searchProviders.includes('academic') || isAcademicDomain) {
      try {
        const academicProvider = this.searchProviderFactory.getProvider('academic');
        const academicResults = await academicProvider.search(
          queryPlan.mainQuery,
          config.maxSearchResults
        );
        allResults.push(...academicResults);
      } catch (error) {
        elizaLogger.warn('Academic search failed, continuing with web results:', error);
      }
    }

    // Score search results for relevance BEFORE processing
    elizaLogger.info(`[ResearchService] Scoring ${allResults.length} search results for relevance`);
    const relevanceScores = new Map<string, any>();

    for (const result of allResults) {
      if (signal.aborted) break;
      const relevanceScore = await this.relevanceAnalyzer.scoreSearchResultRelevance(
        result,
        queryAnalysis
      );
      relevanceScores.set(result.url, relevanceScore);
    }

    // Log search results with relevance scores
    await this.researchLogger.logSearch(
      project.id,
      queryPlan.mainQuery,
      'web+academic',
      allResults,
      relevanceScores
    );

    // Filter and sort by relevance score (minimum threshold 0.3 for more inclusive results)
    const relevantResults = allResults
      .filter((result) => (relevanceScores.get(result.url)?.score || 0) >= 0.3)
      .sort(
        (a, b) =>
          (relevanceScores.get(b.url)?.score || 0) - (relevanceScores.get(a.url)?.score || 0)
      );

    const mainResults = relevantResults.slice(0, config.maxSearchResults);

    elizaLogger.info(
      `[ResearchService] Filtered to ${mainResults.length}/${allResults.length} relevant results (threshold >= 0.3)`
    );

    // Process main results
    for (const result of mainResults) {
      if (signal.aborted) break;

      const source = await this.processSearchResult(result, project);
      if (source) {
        project.sources.push(source);
      }
    }

    // Execute sub-queries
    for (const subQuery of queryPlan.subQueries) {
      if (signal.aborted) break;

      // Check dependencies
      const dependenciesMet = subQuery.dependsOn.every(
        (depId) => queryPlan.subQueries.find((sq) => sq.id === depId)?.completed
      );

      if (!dependenciesMet) continue;

      const subResults = await webProvider.search(
        subQuery.query,
        Math.floor(config.maxSearchResults / 2)
      );

      for (const result of subResults) {
        if (signal.aborted) break;

        const source = await this.processSearchResult(result, project);
        if (source) {
          project.sources.push(source);
        }
      }

      subQuery.completed = true;
    }

    // Update iteration history
    const iteration: IterationRecord = {
      iteration: project.metadata.iterationHistory.length + 1,
      timestamp: Date.now(),
      queriesUsed: [queryPlan.mainQuery, ...queryPlan.subQueries.map((sq) => sq.query)],
      sourcesFound: project.sources.length,
      findingsExtracted: 0,
      qualityScore: 0,
    };

    project.metadata.iterationHistory.push(iteration);

    // Adaptive refinement if needed
    if (queryPlan.adaptiveRefinement && project.sources.length < queryPlan.expectedSources) {
      await this.performAdaptiveRefinement(project, config, signal);
    }
  }

  private async processSearchResult(
    result: SearchResult,
    project: ResearchProject
  ): Promise<ResearchSource | null> {
    try {
      // Skip error results from mock providers
      if ((result.metadata as any)?.error === true) {
        elizaLogger.warn(`[ResearchService] Skipping error result: ${result.title}`);
        return null;
      }

      // Extract content if not already present
      let fullContent = result.content;
      if (!fullContent) {
        // Check if it's a PDF
        if (PDFExtractor.isPDFUrl(result.url)) {
          const pdfExtractor = this.searchProviderFactory.getPDFExtractor();
          const pdfContent = await pdfExtractor.extractFromURL(result.url);
          fullContent = pdfContent?.markdown || pdfContent?.content || '';
        } else {
          const contentExtractor = this.searchProviderFactory.getContentExtractor();
          const extracted = await contentExtractor.extractContent(result.url);
          fullContent = extracted.content;
        }
      }

      // Categorize source
      const sourceType = this.categorizeSource(result);

      const source: ResearchSource = {
        id: uuidv4(),
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        fullContent,
        accessedAt: Date.now(),
        type: sourceType,
        reliability: await this.assessReliability(result, sourceType),
        domain: result.metadata?.domain,
        author: result.metadata?.author ? [result.metadata.author].flat() : undefined,
        publishDate: result.metadata?.publishDate,
        metadata: {
          language: result.metadata?.language || 'en',
          journal: result.metadata?.type === 'academic' ? result.metadata.domain : undefined,
        },
      };

      return source;
    } catch (error) {
      elizaLogger.warn(`Failed to process search result ${result.url}:`, error);
      return null;
    }
  }

  private categorizeSource(result: SearchResult): SourceType {
    const url = result.url.toLowerCase();
    const metadata = result.metadata;

    if (url.includes('arxiv.org') || url.includes('pubmed') || url.includes('.edu')) {
      return SourceType.ACADEMIC;
    }
    if (metadata?.type === 'news' || url.includes('news')) {
      return SourceType.NEWS;
    }
    if (url.includes('github.com') || url.includes('docs.')) {
      return SourceType.TECHNICAL;
    }
    if (url.includes('.gov')) {
      return SourceType.GOVERNMENT;
    }
    if (url.includes('.org') && !url.includes('wikipedia')) {
      return SourceType.ORGANIZATION;
    }

    return SourceType.WEB;
  }

  private async assessReliability(result: SearchResult, sourceType: SourceType): Promise<number> {
    let baseScore = 0.5;

    // Adjust based on source type
    switch (sourceType) {
      case SourceType.ACADEMIC:
        baseScore = 0.9;
        break;
      case SourceType.GOVERNMENT:
        baseScore = 0.85;
        break;
      case SourceType.TECHNICAL:
        baseScore = 0.8;
        break;
      case SourceType.NEWS:
        baseScore = 0.7;
        break;
      case SourceType.ORGANIZATION:
        baseScore = 0.75;
        break;
    }

    // Adjust based on metadata
    if (result.metadata?.author) baseScore += 0.05;
    if (result.metadata?.publishDate) baseScore += 0.05;

    return Math.min(baseScore, 1.0);
  }

  private async performAdaptiveRefinement(
    project: ResearchProject,
    config: ResearchConfig,
    signal: AbortSignal
  ): Promise<void> {
    const currentFindings = project.findings.slice(0, 5).map((f) => f.content);
    const refinedQueries = await this.queryPlanner.refineQuery(
      project.query,
      currentFindings,
      project.metadata.iterationHistory.length
    );

    const searchProvider = this.searchProviderFactory.getProvider(config.searchProviders[0]);

    for (const query of refinedQueries) {
      if (signal.aborted) break;

      const results = await searchProvider.search(query, Math.floor(config.maxSearchResults / 3));

      for (const result of results) {
        const source = await this.processSearchResult(result, project);
        if (source) {
          project.sources.push(source);
        }
      }
    }
  }

  private async analyzeFindings(project: ResearchProject, config: ResearchConfig): Promise<void> {
    elizaLogger.info(`[ResearchService] Analyzing ${project.sources.length} sources`);

    for (const source of project.sources) {
      // Use fullContent if available, otherwise fall back to snippet
      const contentToAnalyze = source.fullContent || source.snippet || source.title;

      if (!contentToAnalyze) {
        elizaLogger.warn(`[ResearchService] No content available for source: ${source.url}`);
        continue;
      }

      // Extract key findings
      const findings = await this.extractFindings(source, project.query, contentToAnalyze);

      // Extract factual claims
      const claims = await this.extractFactualClaims(source, contentToAnalyze);

      // Create research findings
      for (const finding of findings) {
        const researchFinding: ResearchFinding = {
          id: uuidv4(),
          content: finding.content,
          source,
          relevance: finding.relevance,
          confidence: finding.confidence,
          timestamp: Date.now(),
          category: finding.category,
          citations: [],
          factualClaims: claims.filter((c) =>
            finding.content.toLowerCase().includes(c.statement.substring(0, 30).toLowerCase())
          ),
          relatedFindings: [],
          verificationStatus: VerificationStatus.PENDING,
          extractionMethod: source.fullContent ? 'llm-extraction' : 'snippet-extraction',
        };

        project.findings.push(researchFinding);
      }
    }

    elizaLogger.info(`[ResearchService] Extracted ${project.findings.length} findings`);

    // Update quality score
    const lastIteration =
      project.metadata.iterationHistory[project.metadata.iterationHistory.length - 1];
    if (lastIteration) {
      lastIteration.findingsExtracted = project.findings.length;
      lastIteration.qualityScore = this.calculateQualityScore(project);
    }
  }

  private async extractFindings(
    source: ResearchSource,
    query: string,
    content: string
  ): Promise<Array<{ content: string; relevance: number; confidence: number; category: string }>> {
    // Sanitize content before processing
    const sanitizedContent = this.sanitizeContentForLLM(content);

    if (!sanitizedContent || sanitizedContent.length < 50) {
      elizaLogger.warn(
        `[ResearchService] Content too short or empty after sanitization for ${source.title}`
      );
      return [];
    }

    const prompt = `Extract key findings from this source that are relevant to the research query.
    
Research Query: "${query}"
Source: ${source.title}
URL: ${source.url}
Content: ${sanitizedContent.substring(0, 3000)}...

For each finding:
1. Extract the specific finding/insight
2. Rate relevance to query (0-1)
3. Rate confidence in the finding (0-1)
4. Categorize (fact, opinion, data, theory, method, result)

IMPORTANT: Return a valid JSON array. If no relevant findings, return an empty array [].
Format as JSON array:
[{
  "content": "finding text",
  "relevance": 0.9,
  "confidence": 0.8,
  "category": "fact"
}]`;

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: 'system',
          content:
            'You are a research analyst extracting key findings from sources. Always return a valid JSON array.',
        },
        { role: 'user', content: prompt },
      ],
    });

    try {
      const responseContent =
        typeof response === 'string' ? response : (response as any).content || '';

      // Handle case where LLM returns just an empty array
      if (responseContent.trim() === '[]') {
        elizaLogger.info(`[ResearchService] No findings found by LLM for ${source.title}`);
        return [];
      }

      // Try to extract JSON from the response
      const jsonMatch = responseContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const findings = JSON.parse(jsonMatch[0]);
        // Validate findings structure
        if (Array.isArray(findings) && findings.length > 0) {
          const validFindings = findings.filter(
            (f) =>
              f.content &&
              typeof f.content === 'string' &&
              f.content.length > 10 &&
              typeof f.relevance === 'number' &&
              typeof f.confidence === 'number' &&
              f.category
          );
          return validFindings;
        }
      }

      // If no valid JSON found, try fallback
      elizaLogger.warn(`[ResearchService] No valid findings extracted for ${source.title}`);

      // Fallback: Create a single finding if content seems relevant
      if (sanitizedContent.length > 100) {
        const fallbackFinding = {
          content: `From ${source.title}: ${sanitizedContent.substring(0, 300).trim()}...`,
          relevance: 0.5,
          confidence: 0.6,
          category: 'fact' as const,
        };
        return [fallbackFinding];
      }

      return [];
    } catch (e) {
      elizaLogger.error('[ResearchService] Failed to extract findings from source:', {
        sourceUrl: source.url,
        error: e instanceof Error ? e.message : String(e),
        contentLength: content.length,
        sanitizedContentLength: sanitizedContent.length,
      });

      // Return empty array instead of fake findings - let the caller handle the failure
      return [];
    }
  }

  private async extractFactualClaims(
    source: ResearchSource,
    content: string
  ): Promise<FactualClaim[]> {
    // Sanitize content before processing
    const sanitizedContent = this.sanitizeContentForLLM(content);

    if (!sanitizedContent || sanitizedContent.length < 50) {
      elizaLogger.warn(
        `[ResearchService] Content too short for claim extraction from ${source.title}`
      );
      return [];
    }

    const prompt = `Extract specific factual claims from this source that can be verified.
    
Source: ${source.title}
Content: ${sanitizedContent.substring(0, 2000)}...

For each factual claim:
1. Extract the exact statement
2. Identify supporting evidence in the text
3. Rate confidence (0-1)

IMPORTANT: Return a valid JSON array. If no claims found, return an empty array [].
Format as JSON array:
[{
  "statement": "claim text",
  "evidence": ["supporting text 1", "supporting text 2"],
  "confidence": 0.9
}]`;

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: 'system',
          content:
            'You are a fact-checker extracting verifiable claims from sources. Always return a valid JSON array.',
        },
        { role: 'user', content: prompt },
      ],
    });

    try {
      const responseContent =
        typeof response === 'string' ? response : (response as any).content || '';

      // Handle case where LLM returns just an empty array
      if (responseContent.trim() === '[]') {
        elizaLogger.info(`[ResearchService] No claims found in ${source.title}`);
        return [];
      }

      // Try to extract JSON from the response
      const jsonMatch = responseContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const claims = JSON.parse(jsonMatch[0]);
        if (Array.isArray(claims)) {
          return claims
            .filter((claim: any) => claim.statement && typeof claim.statement === 'string')
            .map((claim: any) => ({
              id: uuidv4(),
              statement: claim.statement,
              supportingEvidence: Array.isArray(claim.evidence) ? claim.evidence : [],
              sourceUrls: [source.url],
              verificationStatus: VerificationStatus.UNVERIFIED,
              confidenceScore: typeof claim.confidence === 'number' ? claim.confidence : 0.5,
              relatedClaims: [],
            }));
        }
      }
      return [];
    } catch (e) {
      elizaLogger.warn('[ResearchService] Failed to parse claims:', {
        error: e instanceof Error ? e.message : String(e),
        sourceUrl: source.url,
      });
      return [];
    }
  }

  private calculateQualityScore(project: ResearchProject): number {
    const sourceQuality =
      project.sources.reduce((sum, s) => sum + s.reliability, 0) / project.sources.length;
    const findingQuality =
      project.findings.reduce((sum, f) => sum + f.relevance * f.confidence, 0) /
      project.findings.length;
    const coverage = Math.min(
      project.sources.length / project.metadata.queryPlan.expectedSources,
      1
    );

    return sourceQuality * 0.3 + findingQuality * 0.5 + coverage * 0.2;
  }

  private async synthesizeFindings(project: ResearchProject): Promise<void> {
    elizaLogger.info(
      `[ResearchService] Starting synthesis for ${project.findings.length} findings`
    );

    // Group findings by category
    const categories = new Map<string, ResearchFinding[]>();
    for (const finding of project.findings) {
      const existing = categories.get(finding.category) || [];
      existing.push(finding);
      categories.set(finding.category, existing);
    }

    // Synthesize by category
    const categoryAnalysis: Record<string, string> = {};
    for (const [category, findings] of categories) {
      const synthesis = await this.synthesizeCategory(category, findings);
      categoryAnalysis[category] = synthesis;
    }

    // Overall synthesis
    const overallSynthesis = await this.createOverallSynthesis(project, categoryAnalysis);

    // Update metadata
    project.metadata.categoryAnalysis = categoryAnalysis;
    project.metadata.synthesis = overallSynthesis;

    elizaLogger.info(
      `[ResearchService] Synthesis completed. Overall synthesis length: ${overallSynthesis.length} characters`
    );
  }

  private async synthesizeCategory(category: string, findings: ResearchFinding[]): Promise<string> {
    const findingTexts = findings.map((f) => f.content).join('\n\n');

    const prompt = `Synthesize these ${category} findings into a coherent summary:
    
${findingTexts}

Create a comprehensive synthesis that:
1. Identifies common themes
2. Notes contradictions or debates
3. Highlights key insights
4. Maintains academic rigor`;

    elizaLogger.debug(
      `[ResearchService] Calling LLM for category synthesis with prompt length: ${prompt.length}`
    );

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [{ role: 'user', content: prompt }],
    });

    const result = typeof response === 'string' ? response : (response as any).content || '';
    elizaLogger.debug(`[ResearchService] Category synthesis response length: ${result.length}`);
    return result;
  }

  private async createOverallSynthesis(
    project: ResearchProject,
    categoryAnalysis: Record<string, string>
  ): Promise<string> {
    const prompt = `Create an overall synthesis of this research project:
    
Research Query: "${project.query}"
Domain: ${project.metadata.domain}
Task Type: ${project.metadata.taskType}

Category Analyses:
${Object.entries(categoryAnalysis)
  .map(([cat, analysis]) => `${cat}:\n${analysis}`)
  .join('\n\n')}

Create a comprehensive synthesis that:
1. Answers the original research question
2. Integrates insights across categories
3. Identifies knowledge gaps
4. Suggests future research directions`;

    elizaLogger.debug(
      `[ResearchService] Calling LLM for overall synthesis with prompt length: ${prompt.length}`
    );

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [{ role: 'user', content: prompt }],
    });

    const result = typeof response === 'string' ? response : (response as any).content || '';
    elizaLogger.debug(`[ResearchService] Overall synthesis response length: ${result.length}`);
    return result;
  }

  private async generateReport(project: ResearchProject): Promise<void> {
    try {
      elizaLogger.info(
        `[ResearchService] Generating comprehensive report for project ${project.id}`
      );

      // Use new prompt templates for better structure
      const queryAnalysis = await this.analyzeQueryForReport(project);

      // Step 1: Generate initial comprehensive report
      const initialSections = await this.generateComprehensiveReport(project);

      // Step 2: Extract and verify claims from initial report
      const claims = await this.extractClaimsFromReport(initialSections, project);
      const verificationResults = await this.verifyClaimsWithSources(claims, project);

      // Step 3: Enhance report with verification results and detailed analysis
      const enhancedSections = await this.enhanceReportWithDetailedAnalysis(
        project,
        initialSections,
        verificationResults
      );

      // Step 4: Add executive summary and finalize
      const executiveSummary = await this.generateExecutiveSummary(project, verificationResults);

      // Build final report with citations and bibliography
      const fullReport = this.buildFinalReport(executiveSummary, enhancedSections, project);

      // Build proper ResearchReport structure
      const wordCount = fullReport.split(' ').length;
      const readingTime = Math.ceil(wordCount / 200);

      project.report = {
        id: uuidv4(),
        title: `Research Report: ${project.query}`,
        abstract: executiveSummary.substring(0, 300) + '...',
        summary: executiveSummary,
        sections: enhancedSections,
        citations: this.extractAllCitations(project),
        bibliography: this.createBibliography(project),
        generatedAt: Date.now(),
        wordCount,
        readingTime,
        evaluationMetrics: {
          raceScore: {
            overall: 0,
            comprehensiveness: 0,
            depth: 0,
            instructionFollowing: 0,
            readability: 0,
            breakdown: [],
          },
          factScore: {
            citationAccuracy: 0,
            effectiveCitations: 0,
            totalCitations: 0,
            verifiedCitations: 0,
            disputedCitations: 0,
            citationCoverage: 0,
            sourceCredibility: 0,
            breakdown: [],
          },
          timestamp: Date.now(),
          evaluatorVersion: '1.0',
        },
        exportFormats: [
          { format: 'json', generated: false },
          { format: 'markdown', generated: false },
          { format: 'deepresearch', generated: false },
        ],
      };

      // Save to file
      await this.saveReportToFile(project);

      elizaLogger.info('[ResearchService] Report generation complete');
    } catch (error) {
      elizaLogger.error('[ResearchService] Report generation failed:', error);
      throw error;
    }
  }

  private async analyzeQueryForReport(project: ResearchProject): Promise<any> {
    const prompt = formatPrompt(RESEARCH_PROMPTS.QUERY_ANALYSIS, { query: project.query });

    const config = getPromptConfig('analysis');
    const response = await this.runtime.useModel(config.modelType, {
      messages: [
        { role: 'system', content: 'You are an expert research analyst.' },
        { role: 'user', content: prompt },
      ],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    });

    try {
      const content = typeof response === 'string' ? response : response.content || '';
      return JSON.parse(content);
    } catch {
      return { query: project.query, concepts: [], dimensions: [] };
    }
  }

  private async extractClaimsFromReport(
    sections: ReportSection[],
    project: ResearchProject
  ): Promise<FactualClaim[]> {
    const claims: FactualClaim[] = [];

    for (const section of sections) {
      const sectionClaims = await this.extractClaimsFromText(section.content, project.sources);
      claims.push(...sectionClaims);
    }

    return claims;
  }

  private async extractClaimsFromText(
    text: string,
    sources: ResearchSource[]
  ): Promise<FactualClaim[]> {
    const prompt = formatPrompt(RESEARCH_PROMPTS.CLAIM_EXTRACTION, {
      text,
      sourceCount: sources.length,
    });

    const config = getPromptConfig('extraction');
    const response = await this.runtime.useModel(config.modelType, {
      messages: [
        { role: 'system', content: 'Extract specific, verifiable claims from the text.' },
        { role: 'user', content: prompt },
      ],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    });

    try {
      const content = typeof response === 'string' ? response : response.content || '';
      const extractedClaims = JSON.parse(content).claims || [];

      return extractedClaims.map((claim: any) => ({
        statement: claim.statement,
        confidence: claim.confidence || 0.5,
        sourceUrls: claim.sources || [],
        supportingEvidence: claim.evidence || [],
        category: claim.category || 'general',
      }));
    } catch {
      return [];
    }
  }

  private async verifyClaimsWithSources(
    claims: FactualClaim[],
    project: ResearchProject
  ): Promise<Map<string, any>> {
    const verificationResults = new Map();

    // Group claims by primary source for efficient verification
    const claimsBySource = new Map<string, FactualClaim[]>();

    for (const claim of claims) {
      const primaryUrl = claim.sourceUrls[0];
      if (primaryUrl) {
        if (!claimsBySource.has(primaryUrl)) {
          claimsBySource.set(primaryUrl, []);
        }
        claimsBySource.get(primaryUrl)!.push(claim);
      }
    }

    // Verify claims batch by source
    for (const [sourceUrl, sourceClaims] of claimsBySource) {
      const source = project.sources.find((s) => s.url === sourceUrl);
      if (source) {
        const results = await this.claimVerifier.batchVerifyClaims(
          sourceClaims.map((claim) => ({ claim, primarySource: source })),
          project.sources
        );

        results.forEach((result, index) => {
          verificationResults.set(sourceClaims[index].statement, result);
        });
      }
    }

    return verificationResults;
  }

  private buildFinalReport(
    executiveSummary: string,
    sections: ReportSection[],
    project: ResearchProject
  ): string {
    const reportParts = [
      `# ${project.query}`,
      `\n_Generated on ${new Date().toISOString()}_\n`,
      `## Executive Summary\n\n${executiveSummary}\n`,
    ];

    // Add main sections
    for (const section of sections) {
      reportParts.push(`## ${section.heading}\n\n${section.content}\n`);
    }

    // Add methodology section
    const methodology = this.generateMethodologySection(project);
    reportParts.push(`## Research Methodology\n\n${methodology}\n`);

    // Add references
    reportParts.push('## References\n');
    const bibliography = this.createBibliography(project);
    bibliography.forEach((entry, idx) => {
      reportParts.push(`${idx + 1}. ${entry.citation}`);
    });

    return reportParts.join('\n');
  }

  private async saveReportToFile(project: ResearchProject): Promise<void> {
    try {
      // Create logs directory
      const logsDir = path.join(process.cwd(), 'research_logs');
      await fs.mkdir(logsDir, { recursive: true });

      // Generate filename with timestamp and sanitized query
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const sanitizedQuery = project.query
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .substring(0, 50);
      const filename = `${timestamp}_${sanitizedQuery}.md`;
      const filepath = path.join(logsDir, filename);

      // Export as markdown
      const markdownContent = this.exportAsMarkdown(project);

      // Add metadata header
      const fullContent = `---
id: ${project.id}
query: ${project.query}
status: ${project.status}
domain: ${project.metadata.domain}
taskType: ${project.metadata.taskType}
createdAt: ${new Date(project.createdAt).toISOString()}
completedAt: ${project.completedAt ? new Date(project.completedAt).toISOString() : 'In Progress'}
sources: ${project.sources.length}
findings: ${project.findings.length}
---

${markdownContent}

## Metadata

- **Research Domain**: ${project.metadata.domain}
- **Task Type**: ${project.metadata.taskType}
- **Research Depth**: ${project.metadata.depth}
- **Sources Analyzed**: ${project.sources.length}
- **Key Findings**: ${project.findings.length}
- **Word Count**: ${project.report?.wordCount || 'N/A'}
- **Estimated Reading Time**: ${project.report?.readingTime || 'N/A'} minutes

## Source URLs

${project.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n')}
`;

      await fs.writeFile(filepath, fullContent, 'utf-8');
      elizaLogger.info(`[ResearchService] Report saved to: ${filepath}`);

      // Also save JSON version
      const jsonFilepath = filepath.replace('.md', '.json');
      await fs.writeFile(jsonFilepath, JSON.stringify(project, null, 2), 'utf-8');
      elizaLogger.info(`[ResearchService] JSON data saved to: ${jsonFilepath}`);
    } catch (error) {
      elizaLogger.error('[ResearchService] Failed to save report to file:', error);
    }
  }

  /**
   * PASS 1: Generate comprehensive initial report sections
   * Creates detailed sections for each category with thorough analysis
   */
  private async generateComprehensiveReport(project: ResearchProject): Promise<ReportSection[]> {
    elizaLogger.info(
      `[ResearchService] PASS 1: Generating comprehensive initial report for ${project.findings.length} findings`
    );

    const sections: ReportSection[] = [];

    // Group findings by category for organized analysis
    const categories = new Map<string, ResearchFinding[]>();
    for (const finding of project.findings) {
      const existing = categories.get(finding.category) || [];
      existing.push(finding);
      categories.set(finding.category, existing);
    }

    elizaLogger.info(
      `[ResearchService] Found ${categories.size} categories: ${Array.from(categories.keys()).join(', ')}`
    );

    // Create executive summary
    const executiveSummary = await this.generateExecutiveSummary(project, new Map());
    sections.push({
      id: 'executive-summary',
      heading: 'Executive Summary',
      level: 0,
      content: executiveSummary,
      findings: [],
      citations: [],
      metadata: {
        wordCount: executiveSummary.split(' ').length,
        citationDensity: 0,
        readabilityScore: 0,
        keyTerms: [],
      },
    });

    // Generate comprehensive sections for each category
    for (const [category, findings] of categories.entries()) {
      elizaLogger.info(
        `[ResearchService] PASS 1: Generating comprehensive analysis for category: ${category} (${findings.length} findings)`
      );

      const categoryAnalysis = await this.generateDetailedCategoryAnalysis(
        category,
        findings,
        project.query
      );

      sections.push({
        id: `comprehensive-${category}`,
        heading: this.formatCategoryHeading(category),
        level: 1,
        content: categoryAnalysis,
        findings: findings.map((f) => f.id),
        citations: this.extractCitations(findings),
        metadata: {
          wordCount: categoryAnalysis.split(' ').length,
          citationDensity: findings.length / (categoryAnalysis.split(' ').length / 100),
          readabilityScore: 0,
          keyTerms: [],
        },
      });
    }

    // Generate methodology section
    const methodology = await this.generateMethodologySection(project);
    sections.push({
      id: 'methodology',
      heading: 'Research Methodology',
      level: 1,
      content: methodology,
      findings: [],
      citations: [],
      metadata: {
        wordCount: methodology.split(' ').length,
        citationDensity: 0,
        readabilityScore: 0,
        keyTerms: [],
      },
    });

    // Generate implications and future work
    const implications = await this.generateImplicationsSection(project);
    sections.push({
      id: 'implications',
      heading: 'Implications and Future Directions',
      level: 1,
      content: implications,
      findings: [],
      citations: [],
      metadata: {
        wordCount: implications.split(' ').length,
        citationDensity: 0,
        readabilityScore: 0,
        keyTerms: [],
      },
    });

    const totalWords = sections.reduce((sum, s) => sum + s.metadata.wordCount, 0);
    elizaLogger.info(
      `[ResearchService] PASS 1 completed: Generated ${sections.length} sections with ${totalWords} total words`
    );

    return sections;
  }

  /**
   * PASS 2: Enhance report with detailed source analysis
   * Identifies top sources, extracts detailed content, and performs comprehensive rewrite
   */
  private async enhanceReportWithDetailedAnalysis(
    project: ResearchProject,
    initialSections: ReportSection[],
    verificationResults: Map<string, any>
  ): Promise<ReportSection[]> {
    elizaLogger.info(`[ResearchService] PASS 2: Beginning detailed source analysis enhancement`);

    // Step 1: Identify top 10 sources
    const topSources = this.identifyTopSources(project, 10);
    elizaLogger.info(
      `[ResearchService] PASS 2: Identified top ${topSources.length} sources for detailed analysis`
    );

    // Step 2: Extract 10k words from each top source
    const detailedSourceContent = await this.extractDetailedSourceContent(topSources);
    elizaLogger.info(
      `[ResearchService] PASS 2: Extracted detailed content from ${detailedSourceContent.size} sources`
    );

    // Step 3: Enhance each section with detailed analysis
    const enhancedSections: ReportSection[] = [];

    for (const section of initialSections) {
      elizaLogger.info(
        `[ResearchService] PASS 2: Enhancing section "${section.heading}" with detailed analysis`
      );

      const enhancedContent = await this.enhanceSection(section, detailedSourceContent, project);
      const enhancedSection = {
        ...section,
        content: enhancedContent,
        metadata: {
          ...section.metadata,
          wordCount: enhancedContent.split(' ').length,
        },
      };

      enhancedSections.push(enhancedSection);
    }

    // Step 4: Add detailed source analysis section
    const detailedAnalysis = await this.generateDetailedSourceAnalysis(
      detailedSourceContent,
      project
    );
    enhancedSections.push({
      id: 'detailed-source-analysis',
      heading: 'Detailed Source Analysis',
      level: 1,
      content: detailedAnalysis,
      findings: [],
      citations: [],
      metadata: {
        wordCount: detailedAnalysis.split(' ').length,
        citationDensity: 0,
        readabilityScore: 0,
        keyTerms: [],
      },
    });

    const totalWords = enhancedSections.reduce((sum, s) => sum + s.metadata.wordCount, 0);
    elizaLogger.info(
      `[ResearchService] PASS 2 completed: Enhanced ${enhancedSections.length} sections with ${totalWords} total words`
    );

    return enhancedSections;
  }

  private async generateExecutiveSummary(
    project: ResearchProject,
    verificationResults: Map<string, any>
  ): Promise<string> {
    const findingsSample = project.findings
      .slice(0, 10)
      .map((f) => f.content)
      .join('\n\n');

    const prompt = `Create a comprehensive executive summary for this research project.

Research Query: "${project.query}"

Key Findings Sample:
${findingsSample}

Total Sources: ${project.sources.length}
Total Findings: ${project.findings.length}

Create a 400-500 word executive summary that:
1. States the research objective clearly
2. Summarizes the methodology used
3. Highlights the most significant findings
4. Discusses key implications
5. Provides actionable insights

Focus on being comprehensive yet accessible, suitable for both technical and non-technical audiences.`;

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: 'system',
          content:
            'You are a research analyst creating executive summaries for comprehensive research reports.',
        },
        { role: 'user', content: prompt },
      ],
    });

    return typeof response === 'string' ? response : (response as any).content || '';
  }

  private async generateDetailedCategoryAnalysis(
    category: string,
    findings: ResearchFinding[],
    originalQuery: string
  ): Promise<string> {
    const findingTexts = findings.map((f) => f.content).join('\n\n');

    const prompt = `Create a comprehensive analysis for the category "${category}" based on these research findings.

Original Research Query: "${originalQuery}"

Findings in this category:
${findingTexts}

Create a detailed 800-1200 word analysis that:
1. Introduces the category and its relevance to the research question
2. Analyzes patterns and themes across findings
3. Discusses methodological approaches mentioned
4. Identifies consensus and disagreements in the literature
5. Evaluates the strength of evidence
6. Discusses limitations and gaps
7. Connects findings to broader implications
8. Suggests areas for future research

Use a scholarly tone with clear subsections. Be thorough and analytical.`;

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: 'system',
          content: 'You are a research analyst writing comprehensive literature reviews.',
        },
        { role: 'user', content: prompt },
      ],
    });

    return typeof response === 'string' ? response : (response as any).content || '';
  }

  private async generateMethodologySection(project: ResearchProject): Promise<string> {
    const searchProviders = project.sources
      .map((s) => s.url.split('.')[1] || 'unknown')
      .slice(0, 5);
    const domains = [...new Set(project.sources.map((s) => s.type))];

    const prompt = `Create a comprehensive methodology section for this research project.

Research Query: "${project.query}"
Sources Analyzed: ${project.sources.length}
Search Domains: ${domains.join(', ')}
Key Findings: ${project.findings.length}

Create a 400-600 word methodology section that describes:
1. Research approach and design
2. Search strategy and keywords used
3. Source selection criteria
4. Data extraction methods
5. Quality assessment procedures
6. Analysis framework
7. Limitations and potential biases

Be specific about the systematic approach taken and justify methodological choices.`;

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: 'system',
          content: 'You are a research methodologist describing systematic research approaches.',
        },
        { role: 'user', content: prompt },
      ],
    });

    return typeof response === 'string' ? response : (response as any).content || '';
  }

  private async generateImplicationsSection(project: ResearchProject): Promise<string> {
    const keyFindings = project.findings
      .sort((a, b) => b.relevance * b.confidence - a.relevance * a.confidence)
      .slice(0, 8)
      .map((f) => f.content)
      .join('\n\n');

    const prompt = `Create a comprehensive implications and future directions section.

Research Query: "${project.query}"

Key Findings:
${keyFindings}

Create a 600-800 word section that:
1. Discusses theoretical implications
2. Identifies practical applications
3. Considers policy implications (if relevant)
4. Addresses methodological contributions
5. Suggests specific future research directions
6. Discusses potential real-world impact
7. Identifies research gaps that need attention
8. Proposes concrete next steps

Be forward-looking and actionable while grounding recommendations in the evidence found.`;

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: 'system',
          content:
            'You are a research strategist identifying implications and future research directions.',
        },
        { role: 'user', content: prompt },
      ],
    });

    return typeof response === 'string' ? response : (response as any).content || '';
  }

  private identifyTopSources(project: ResearchProject, count: number): ResearchSource[] {
    // Score sources based on multiple criteria
    const scoredSources = project.sources.map((source) => {
      const findingsFromSource = project.findings.filter((f) => f.source.id === source.id);
      const avgRelevance =
        findingsFromSource.reduce((sum, f) => sum + f.relevance, 0) /
        Math.max(findingsFromSource.length, 1);
      const avgConfidence =
        findingsFromSource.reduce((sum, f) => sum + f.confidence, 0) /
        Math.max(findingsFromSource.length, 1);
      const contentLength = source.fullContent?.length || source.snippet?.length || 0;

      // Scoring formula: findings count + avg relevance + avg confidence + content richness + source reliability
      const score =
        findingsFromSource.length * 2 +
        avgRelevance +
        avgConfidence +
        (contentLength > 5000 ? 1 : 0) +
        source.reliability;

      return { source, score, findingsCount: findingsFromSource.length };
    });

    // Sort by score and return top sources
    return scoredSources
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map((s) => {
        elizaLogger.info(
          `[ResearchService] Top source: ${s.source.title} (Score: ${s.score.toFixed(2)}, Findings: ${s.findingsCount})`
        );
        return s.source;
      });
  }

  private async extractDetailedSourceContent(
    sources: ResearchSource[]
  ): Promise<Map<string, string>> {
    const detailedContent = new Map<string, string>();

    for (const source of sources) {
      try {
        elizaLogger.info(`[ResearchService] Extracting detailed content from: ${source.title}`);

        let content = source.fullContent || source.snippet || '';

        // If we need more content, try to re-extract with higher limits
        if (content.length < 8000 && source.url) {
          elizaLogger.info(`[ResearchService] Re-extracting with higher limits for: ${source.url}`);
          const extractor = this.searchProviderFactory.getContentExtractor();
          const extractedContent = await extractor.extractContent(source.url);
          const extractedText =
            typeof extractedContent === 'string'
              ? extractedContent
              : extractedContent?.content || '';
          if (extractedText && extractedText.length > content.length) {
            content = extractedText;
          }
        }

        // Take first 10k words
        const words = content.split(/\s+/).slice(0, 10000);
        const detailedText = words.join(' ');

        detailedContent.set(source.id, detailedText);
        elizaLogger.info(
          `[ResearchService] Extracted ${detailedText.length} characters from ${source.title}`
        );
      } catch (error) {
        elizaLogger.warn(
          `[ResearchService] Failed to extract detailed content from ${source.title}:`,
          error
        );
      }
    }

    return detailedContent;
  }

  private async enhanceSection(
    section: ReportSection,
    detailedContent: Map<string, string>,
    project: ResearchProject
  ): Promise<string> {
    // Get relevant detailed content for this section
    const relevantSources: string[] = [];
    for (const findingId of section.findings) {
      const finding = project.findings.find((f) => f.id === findingId);
      if (finding && detailedContent.has(finding.source.id)) {
        relevantSources.push(detailedContent.get(finding.source.id)!);
      }
    }

    if (relevantSources.length === 0) {
      elizaLogger.info(
        `[ResearchService] No detailed content available for section: ${section.heading}`
      );
      return section.content;
    }

    const combinedDetailedContent = relevantSources.join('\n\n---\n\n').substring(0, 15000);

    const prompt = `Enhance this research section with detailed analysis from additional source material.

Original Section: "${section.heading}"
Original Content:
${section.content}

Detailed Source Material (first 15k chars):
${combinedDetailedContent}

Your task:
1. Rewrite the section to be more comprehensive and detailed
2. Incorporate specific details, examples, and evidence from the detailed source material
3. Add nuanced analysis and insights not present in the original
4. Correct any potential inaccuracies using the detailed sources
5. Expand the discussion while maintaining focus and relevance
6. Aim for 800-1200 words for major sections, 400-600 for smaller ones

Maintain the academic tone and ensure all claims are well-supported by the source material.`;

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: 'system',
          content: 'You are a research analyst enhancing reports with detailed source analysis.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const enhancedContent =
      typeof response === 'string' ? response : (response as any).content || section.content;
    elizaLogger.info(
      `[ResearchService] Enhanced section "${section.heading}" from ${section.content.length} to ${enhancedContent.length} characters`
    );

    return enhancedContent;
  }

  private async generateDetailedSourceAnalysis(
    detailedContent: Map<string, string>,
    project: ResearchProject
  ): Promise<string> {
    const sourceAnalyses: string[] = [];

    for (const [sourceId, content] of detailedContent.entries()) {
      const source = project.sources.find((s) => s.id === sourceId);
      if (!source) continue;

      const findings = project.findings.filter((f) => f.source.id === sourceId);

      const analysisPrompt = `Conduct a detailed analysis of this research source.

Source: ${source.title}
URL: ${source.url}
Findings Extracted: ${findings.length}

Source Content (first 5k chars):
${content.substring(0, 5000)}

Create a comprehensive analysis (300-400 words) that:
1. Evaluates the credibility and authority of the source
2. Assesses the methodology used (if applicable)
3. Discusses the strength of evidence presented
4. Identifies key contributions to the research question
5. Notes any limitations or biases
6. Compares findings with other sources in the literature

Be critical yet fair in your assessment.`;

      const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        messages: [
          {
            role: 'system',
            content: 'You are a research analyst conducting detailed source evaluations.',
          },
          { role: 'user', content: analysisPrompt },
        ],
      });

      const analysis = typeof response === 'string' ? response : (response as any).content || '';
      sourceAnalyses.push(`### ${source.title}\n\n${analysis}`);
    }

    const fullAnalysis = `This section provides detailed analysis of the top sources identified for this research project, offering critical evaluation of their methodology, findings, and contributions to our understanding of the research question.

${sourceAnalyses.join('\n\n')}

## Summary of Source Quality

Based on the detailed analysis above, the sources demonstrate varying levels of methodological rigor and relevance to the research question. The majority provide valuable insights through peer-reviewed research, while some offer practical perspectives from industry applications. This diversity of source types strengthens the overall evidence base for our conclusions.`;

    return fullAnalysis;
  }

  private formatCategoryHeading(category: string): string {
    return category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, ' ');
  }

  private extractCitations(findings: ResearchFinding[]): Citation[] {
    const citations: Citation[] = [];

    for (const finding of findings) {
      for (const claim of finding.factualClaims) {
        citations.push({
          id: uuidv4(),
          text: claim.statement,
          source: finding.source,
          confidence: claim.confidenceScore,
          verificationStatus: claim.verificationStatus,
          context: finding.content,
          usageCount: 1,
        });
      }
    }

    return citations;
  }

  private extractAllCitations(project: ResearchProject): Citation[] {
    return this.extractCitations(project.findings);
  }

  private createBibliography(project: ResearchProject): BibliographyEntry[] {
    const entries: BibliographyEntry[] = [];
    const processedUrls = new Set<string>();

    for (const source of project.sources) {
      if (processedUrls.has(source.url)) continue;
      processedUrls.add(source.url);

      const authors = source.author?.join(', ') || 'Unknown';
      const year = source.publishDate ? new Date(source.publishDate).getFullYear() : 'n.d.';
      const citation = `${authors} (${year}). ${source.title}. Retrieved from ${source.url}`;

      entries.push({
        id: source.id,
        citation,
        format: 'APA',
        source,
        accessCount: project.findings.filter((f) => f.source.id === source.id).length,
      });
    }

    return entries.sort((a, b) => a.citation.localeCompare(b.citation));
  }

  async evaluateProject(projectId: string): Promise<EvaluationResults> {
    const project = this.projects.get(projectId);
    if (!project || !project.report) {
      throw new Error('Project not found or report not generated');
    }

    const evaluationMetrics = await this.evaluator.evaluateProject(
      project,
      project.metadata.evaluationCriteria
    );

    // Construct the full EvaluationResults object
    const evaluation: EvaluationResults = {
      projectId: project.id,
      raceEvaluation: {
        scores: evaluationMetrics.raceScore,
        detailedFeedback: [],
      },
      factEvaluation: {
        scores: evaluationMetrics.factScore,
        citationMap: {
          claims: new Map(),
          sources: new Map(),
          verification: new Map(),
        },
        verificationDetails: [],
      },
      overallScore: evaluationMetrics.raceScore.overall,
      recommendations: this.generateRecommendations(evaluationMetrics),
      timestamp: Date.now(),
    };

    // Update project with evaluation results
    project.evaluationResults = evaluation;

    // Update report metrics
    if (project.report) {
      project.report.evaluationMetrics = {
        raceScore: evaluationMetrics.raceScore,
        factScore: evaluationMetrics.factScore,
        timestamp: evaluation.timestamp,
        evaluatorVersion: '1.0',
      };
    }

    return evaluation;
  }

  private generateRecommendations(metrics: EvaluationMetrics): string[] {
    const recommendations: string[] = [];
    const race = metrics.raceScore;
    const fact = metrics.factScore;

    if (race.comprehensiveness < 0.7) {
      recommendations.push('Expand coverage to include more aspects of the research topic');
    }
    if (race.depth < 0.7) {
      recommendations.push('Provide deeper analysis and more detailed explanations');
    }
    if (race.readability < 0.7) {
      recommendations.push('Improve clarity and structure for better readability');
    }
    if (fact.citationAccuracy < 0.7) {
      recommendations.push('Verify citations and ensure claims are properly supported');
    }
    if (fact.effectiveCitations < fact.totalCitations * 0.8) {
      recommendations.push('Remove duplicate or redundant citations');
    }

    return recommendations;
  }

  async exportProject(
    projectId: string,
    format: 'json' | 'markdown' | 'deepresearch'
  ): Promise<string> {
    const project = this.projects.get(projectId);
    if (!project || !project.report) {
      throw new Error('Project not found or report not generated');
    }

    switch (format) {
      case 'json':
        return JSON.stringify(project, null, 2);

      case 'markdown':
        return this.exportAsMarkdown(project);

      case 'deepresearch':
        return JSON.stringify(this.exportAsDeepResearchBench(project));

      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  private exportAsMarkdown(project: ResearchProject): string {
    if (!project.report) return '';

    let markdown = `# ${project.report.title}\n\n`;
    markdown += `**Generated:** ${new Date(project.report.generatedAt).toISOString()}\n\n`;
    markdown += `## Abstract\n\n${project.report.abstract}\n\n`;

    for (const section of project.report.sections) {
      const heading = '#'.repeat(section.level + 1);
      markdown += `${heading} ${section.heading}\n\n`;
      markdown += `${section.content}\n\n`;
    }

    markdown += `## References\n\n`;
    for (const entry of project.report.bibliography) {
      markdown += `- ${entry.citation}\n`;
    }

    return markdown;
  }

  private exportAsDeepResearchBench(project: ResearchProject): DeepResearchBenchResult {
    if (!project.report) throw new Error('Report not generated');

    const article = project.report.sections.map((s) => `${s.heading}\n\n${s.content}`).join('\n\n');

    return {
      id: project.id,
      prompt: project.query,
      article,
      metadata: {
        domain: project.metadata.domain,
        taskType: project.metadata.taskType,
        generatedAt: new Date().toISOString(),
        modelVersion: 'eliza-research-1.0',
        evaluationScores: project.report.evaluationMetrics
          ? {
              race: project.report.evaluationMetrics.raceScore,
              fact: project.report.evaluationMetrics.factScore,
            }
          : {
              race: {
                overall: 0,
                comprehensiveness: 0,
                depth: 0,
                instructionFollowing: 0,
                readability: 0,
                breakdown: [],
              },
              fact: {
                citationAccuracy: 0,
                effectiveCitations: 0,
                totalCitations: 0,
                verifiedCitations: 0,
                disputedCitations: 0,
                citationCoverage: 0,
                sourceCredibility: 0,
                breakdown: [],
              },
            },
      },
    };
  }

  async compareProjects(projectIds: string[]): Promise<any> {
    const projects = projectIds
      .map((id) => this.projects.get(id))
      .filter(Boolean) as ResearchProject[];

    if (projects.length < 2) {
      throw new Error('Need at least 2 projects to compare');
    }

    // Calculate similarity
    const similarity = await this.calculateProjectSimilarity(projects);

    // Find differences
    const differences = await this.findProjectDifferences(projects);

    // Extract unique insights
    const uniqueInsights = await this.extractUniqueInsights(projects);

    // Compare quality
    const qualityComparison = this.compareProjectQuality(projects);

    return {
      projectIds,
      similarity,
      differences,
      uniqueInsights,
      qualityComparison,
      recommendation: await this.generateComparisonRecommendation(
        projects,
        similarity,
        differences
      ),
    };
  }

  private async calculateProjectSimilarity(projects: ResearchProject[]): Promise<number> {
    // Compare domains, findings overlap, source overlap
    const domainMatch = projects.every((p) => p.metadata.domain === projects[0].metadata.domain)
      ? 0.2
      : 0;

    // Compare findings
    const allFindings = projects.flatMap((p) => p.findings.map((f) => f.content));
    const uniqueFindings = new Set(allFindings);
    const overlapRatio = 1 - uniqueFindings.size / allFindings.length;

    return domainMatch + overlapRatio * 0.8;
  }

  private async findProjectDifferences(projects: ResearchProject[]): Promise<string[]> {
    const differences: string[] = [];

    // Domain differences
    const domains = new Set(projects.map((p) => p.metadata.domain));
    if (domains.size > 1) {
      differences.push(
        `Projects span ${domains.size} different domains: ${Array.from(domains).join(', ')}`
      );
    }

    // Approach differences
    const taskTypes = new Set(projects.map((p) => p.metadata.taskType));
    if (taskTypes.size > 1) {
      differences.push(`Different research approaches used: ${Array.from(taskTypes).join(', ')}`);
    }

    // Source type differences
    const sourceTypes = projects.map((p) => {
      const types = new Set(p.sources.map((s) => s.type));
      return Array.from(types);
    });

    return differences;
  }

  private async extractUniqueInsights(
    projects: ResearchProject[]
  ): Promise<Record<string, string[]>> {
    const insights: Record<string, string[]> = {};

    for (const project of projects) {
      const projectInsights = project.findings
        .filter((f) => f.relevance > 0.8 && f.confidence > 0.8)
        .slice(0, 3)
        .map((f) => f.content.substring(0, 200) + '...');

      insights[project.id] = projectInsights;
    }

    return insights;
  }

  /**
   * Sanitizes content for LLM processing by removing HTML entities,
   * excess whitespace, and special characters that might interfere
   */
  private sanitizeContentForLLM(content: string): string {
    if (!content) return '';

    // Decode HTML entities
    const htmlEntities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&nbsp;': ' ',
      '&mdash;': '—',
      '&ndash;': '–',
      '&hellip;': '...',
      '&copy;': '©',
      '&reg;': '®',
      '&trade;': '™',
    };

    let sanitized = content;

    // Replace common HTML entities
    Object.entries(htmlEntities).forEach(([entity, replacement]) => {
      sanitized = sanitized.replace(new RegExp(entity, 'g'), replacement);
    });

    // Remove any remaining HTML tags
    sanitized = sanitized.replace(/<[^>]*>/g, ' ');

    // Remove URLs to reduce noise
    sanitized = sanitized.replace(/https?:\/\/[^\s]+/g, '[URL]');

    // Normalize whitespace
    sanitized = sanitized
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\n{3,}/g, '\n\n') // Limit consecutive newlines
      .trim();

    // Remove non-printable characters
    sanitized = sanitized.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

    // Limit excessive punctuation
    sanitized = sanitized.replace(/([.!?]){4,}/g, '$1$1$1');

    return sanitized;
  }

  private compareProjectQuality(projects: ResearchProject[]): any[] {
    return projects.map((p) => ({
      projectId: p.id,
      sourceCount: p.sources.length,
      findingCount: p.findings.length,
      avgSourceReliability: p.sources.reduce((sum, s) => sum + s.reliability, 0) / p.sources.length,
      evaluationScore: p.evaluationResults?.overallScore || 0,
    }));
  }

  private async generateComparisonRecommendation(
    projects: ResearchProject[],
    similarity: number,
    differences: string[]
  ): Promise<string> {
    if (similarity > 0.8) {
      return 'These projects are highly similar and could be merged or one could be used as validation for the other.';
    } else if (similarity > 0.5) {
      return 'These projects have moderate overlap but explore different aspects. Consider synthesizing insights from both.';
    } else {
      return 'These projects are quite different and provide complementary perspectives on related topics.';
    }
  }

  async addRefinedQueries(projectId: string, queries: string[]): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    // Add as new sub-queries
    const newSubQueries = queries.map((query, index) => ({
      id: `refined_${Date.now()}_${index}`,
      query,
      purpose: 'Refined based on initial findings',
      priority: 2,
      dependsOn: [],
      searchProviders: ['web'],
      expectedResultType:
        project.metadata.taskType === TaskType.ANALYTICAL
          ? ('theoretical' as any)
          : ('factual' as any),
      completed: false,
    }));

    project.metadata.queryPlan.subQueries.push(...newSubQueries);

    // Continue research if active
    if (project.status === ResearchStatus.ACTIVE) {
      const controller = this.activeResearch.get(projectId);
      if (controller) {
        // Execute new queries with project-specific domain
        const config: ResearchConfig = {
          ...this.researchConfig,
          domain: project.metadata.domain,
        };
        await this.executeSearchWithRelevance(project, config, controller.signal, {});
      }
    }
  }

  async pauseResearch(projectId: string): Promise<void> {
    const controller = this.activeResearch.get(projectId);
    if (controller) {
      controller.abort();
    }

    const project = this.projects.get(projectId);
    if (project) {
      project.status = ResearchStatus.PAUSED;
      project.updatedAt = Date.now();
    }
  }

  async resumeResearch(projectId: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project || project.status !== ResearchStatus.PAUSED) {
      throw new Error('Project not found or not paused');
    }

    // Restart research from current phase with project-specific domain
    const config: ResearchConfig = {
      ...this.researchConfig,
      domain: project.metadata.domain,
    };
    this.startResearch(projectId, config).catch((error) => {
      elizaLogger.error(`Failed to resume research ${projectId}:`, error);
    });
  }

  private emitProgress(project: ResearchProject, message: string): void {
    const progress: ResearchProgress = {
      projectId: project.id,
      phase: project.phase,
      message,
      progress: this.calculateProgress(project),
      timestamp: Date.now(),
    };

    // In a real implementation, this would emit to event system
    elizaLogger.info(`Research progress: ${JSON.stringify(progress)}`);
  }

  private calculateProgress(project: ResearchProject): number {
    const phases = Object.values(ResearchPhase);
    const currentIndex = phases.indexOf(project.phase);
    return (currentIndex / (phases.length - 1)) * 100;
  }

  private async analyzeFindingsWithRelevance(
    project: ResearchProject,
    config: ResearchConfig,
    queryAnalysis: any
  ): Promise<void> {
    elizaLogger.info(
      `[ResearchService] Analyzing ${project.sources.length} sources with relevance verification`
    );

    for (const source of project.sources) {
      // Use fullContent if available, otherwise fall back to snippet
      const contentToAnalyze = source.fullContent || source.snippet || source.title;

      if (!contentToAnalyze) {
        elizaLogger.warn(`[ResearchService] No content available for source: ${source.url}`);
        await this.researchLogger.logContentExtraction(
          project.id,
          source.url,
          source.title,
          'none',
          false,
          0,
          'No content available'
        );
        continue;
      }

      // Log content extraction success
      await this.researchLogger.logContentExtraction(
        project.id,
        source.url,
        source.title,
        source.fullContent ? 'content-extractor' : 'snippet',
        true,
        contentToAnalyze.length
      );

      // Extract findings with relevance analysis
      const findings = await this.extractFindingsWithRelevance(
        source,
        project.query,
        contentToAnalyze,
        queryAnalysis
      );

      // Score findings for relevance
      const findingRelevanceScores = new Map<string, any>();
      for (const finding of findings) {
        const relevanceScore = await this.relevanceAnalyzer.scoreFindingRelevance(
          {
            id: uuidv4(),
            content: finding.content,
            source,
            relevance: finding.relevance,
            confidence: finding.confidence,
            timestamp: Date.now(),
            category: finding.category,
            citations: [],
            factualClaims: [],
            relatedFindings: [],
            verificationStatus: VerificationStatus.PENDING,
            extractionMethod: 'llm-extraction',
          },
          queryAnalysis,
          project.query
        );
        findingRelevanceScores.set(finding.content, relevanceScore);
      }

      // Log finding extraction
      await this.researchLogger.logFindingExtraction(
        project.id,
        source.url,
        contentToAnalyze.length,
        findings,
        findingRelevanceScores
      );

      // Keep findings with reasonable relevance scores (>= 0.4)
      // Lower threshold allows more diverse findings while still filtering noise
      const relevantFindings = findings.filter((finding) => {
        const relevanceScore = findingRelevanceScores.get(finding.content);
        const finalScore = relevanceScore?.score || finding.relevance;
        return finalScore >= 0.4;
      });

      if (findings.length > 0) {
        elizaLogger.info(
          `[ResearchService] Kept ${relevantFindings.length}/${findings.length} relevant findings from ${source.title} (threshold >= 0.4)`
        );
      }

      // Extract factual claims for relevant findings
      const claims = await this.extractFactualClaims(source, contentToAnalyze);

      // Create research findings with enhanced relevance information
      for (const finding of relevantFindings) {
        const relevanceScore = findingRelevanceScores.get(finding.content);

        const researchFinding: ResearchFinding = {
          id: uuidv4(),
          content: finding.content,
          source,
          relevance: relevanceScore?.score || finding.relevance,
          confidence: finding.confidence,
          timestamp: Date.now(),
          category: finding.category,
          citations: [],
          factualClaims: claims.filter((c) =>
            finding.content.toLowerCase().includes(c.statement.substring(0, 30).toLowerCase())
          ),
          relatedFindings: [],
          verificationStatus: VerificationStatus.PENDING,
          extractionMethod: source.fullContent
            ? 'llm-extraction-with-relevance'
            : 'snippet-extraction-with-relevance',
        };

        project.findings.push(researchFinding);
      }
    }

    elizaLogger.info(`[ResearchService] Extracted ${project.findings.length} relevant findings`);

    // Update quality score
    const lastIteration =
      project.metadata.iterationHistory[project.metadata.iterationHistory.length - 1];
    if (lastIteration) {
      lastIteration.findingsExtracted = project.findings.length;
      lastIteration.qualityScore = this.calculateQualityScore(project);
    }
  }

  private async extractFindingsWithRelevance(
    source: ResearchSource,
    query: string,
    content: string,
    queryAnalysis: any
  ): Promise<Array<{ content: string; relevance: number; confidence: number; category: string }>> {
    // Sanitize content before processing
    const sanitizedContent = this.sanitizeContentForLLM(content);

    if (!sanitizedContent || sanitizedContent.length < 50) {
      elizaLogger.warn(
        `[ResearchService] Content too short or empty after sanitization for ${source.title}`
      );
      return [];
    }

    // Fallback to less strict extraction if query analysis is missing key fields
    const hasValidQueryAnalysis =
      queryAnalysis?.queryIntent && queryAnalysis?.keyTopics?.length > 0;

    const prompt = hasValidQueryAnalysis
      ? `Extract key findings from this source that relate to the research query.

Research Query: "${query}"
Query Intent: ${queryAnalysis.queryIntent}
Key Topics: ${queryAnalysis.keyTopics.join(', ')}
Required Elements: ${queryAnalysis.requiredElements?.join(', ') || 'None specified'}

Source: ${source.title}
URL: ${source.url}
Content: ${sanitizedContent.substring(0, 3000)}...

Instructions:
1. Extract findings that relate to the research query
2. Include both direct and indirect insights that could be valuable
3. Rate relevance (0-1) - use the full scale, not just high scores
4. Focus on substantive content that adds value
5. Include context and nuance where appropriate

For each finding:
1. Extract the specific finding/insight
2. Rate relevance to query (0-1) - use reasonable scoring
3. Rate confidence in the finding (0-1)
4. Categorize (fact, opinion, data, theory, method, result)

IMPORTANT: Return a valid JSON array. If no relevant findings, return an empty array [].
Format as JSON array:
[{
  "content": "specific finding related to the query",
  "relevance": 0.7,
  "confidence": 0.8,
  "category": "fact"
}]`
      : `Extract key findings from this source that may relate to the research query.

Research Query: "${query}"

Source: ${source.title}
URL: ${source.url}
Content: ${sanitizedContent.substring(0, 3000)}...

Instructions:
1. Extract any findings that could be relevant to the research query
2. Include insights, data points, and analysis
3. Be inclusive rather than overly restrictive
4. Rate relevance based on how well it addresses the query

For each finding:
1. Extract the specific finding/insight
2. Rate relevance to query (0-1)
3. Rate confidence in the finding (0-1)
4. Categorize (fact, opinion, data, theory, method, result)

IMPORTANT: Return a valid JSON array. If no relevant findings, return an empty array [].
Format as JSON array with at least one finding if the content is relevant:
[{
  "content": "specific finding",
  "relevance": 0.6,
  "confidence": 0.8,
  "category": "fact"
}]`;

    elizaLogger.debug(`[ResearchService] Calling LLM for finding extraction:`, {
      sourceTitle: source.title,
      originalContentLength: content.length,
      sanitizedContentLength: sanitizedContent.length,
      promptLength: prompt.length,
      hasValidQueryAnalysis,
    });

    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: 'system',
          content:
            'You are a research analyst extracting relevant findings from sources. Be thorough and inclusive, extracting any content that could be valuable for the research query. Always return a valid JSON array.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5, // Slightly higher temperature for more diverse extraction
    });

    elizaLogger.debug(`[ResearchService] LLM response received:`, {
      responseType: typeof response,
      responseLength: response ? String(response).length : 0,
      responsePreview: response ? String(response).substring(0, 200) : 'null',
    });

    try {
      const responseContent =
        typeof response === 'string' ? response : (response as any).content || '';

      // Handle case where LLM returns just an empty array
      if (responseContent.trim() === '[]') {
        elizaLogger.info(`[ResearchService] No findings found by LLM for ${source.title}`);
        return [];
      }

      // Try to extract JSON from the response
      const jsonMatch = responseContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        let findings;
        try {
          findings = JSON.parse(jsonMatch[0]);
        } catch (parseError) {
          // Try to clean up common JSON issues
          let cleanedJson = jsonMatch[0]
            .replace(/\n/g, ' ') // Remove newlines
            .replace(/,\s*}/g, '}') // Remove trailing commas
            .replace(/,\s*\]/g, ']'); // Remove trailing commas in arrays

          try {
            findings = JSON.parse(cleanedJson);
          } catch (secondParseError) {
            elizaLogger.warn(
              `[ResearchService] Failed to parse JSON response for ${source.title}:`,
              secondParseError
            );
            throw new Error('Invalid JSON in LLM response');
          }
        }

        // Validate findings structure with more lenient filtering
        if (Array.isArray(findings) && findings.length > 0) {
          // More lenient filtering - accept lower relevance scores
          const validFindings = findings.filter(
            (f) =>
              f.content &&
              typeof f.content === 'string' &&
              f.content.length > 10 && // Lower minimum content length
              typeof f.relevance === 'number' &&
              f.relevance >= 0.3 && // Lower relevance threshold
              f.category &&
              typeof f.confidence === 'number'
          );

          if (validFindings.length > 0) {
            elizaLogger.info(
              `[ResearchService] Extracted ${validFindings.length} findings from ${source.title}`
            );
            return validFindings;
          }
        }
      }

      // If no findings extracted, try a simpler approach
      elizaLogger.warn(
        `[ResearchService] No valid findings extracted via JSON for ${source.title}`
      );

      // Fallback: Create a single finding if content seems relevant
      if (sanitizedContent.length > 100) {
        const fallbackFinding = {
          content: `From ${source.title}: ${sanitizedContent.substring(0, 500).trim()}...`,
          relevance: 0.5,
          confidence: 0.6,
          category: 'fact' as const,
        };

        elizaLogger.info(`[ResearchService] Using fallback finding for ${source.title}`);
        return [fallbackFinding];
      }

      // No findings could be extracted - this is OK for some sources
      return [];
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      const errorStack = e instanceof Error ? e.stack : undefined;

      elizaLogger.warn('[ResearchService] Finding extraction challenge:', {
        sourceUrl: source.url,
        sourceTitle: source.title,
        error: errorMessage,
        contentLength: content.length,
        sanitizedContentLength: sanitizedContent.length,
        contentPreview: sanitizedContent.substring(0, 200),
      });

      // Don't log as error if it's just empty findings - this is expected for some sources
      if (
        !errorMessage.includes('No findings could be extracted') &&
        !errorMessage.includes('Invalid JSON')
      ) {
        console.error(`[DETAILED ERROR] Finding extraction failed for ${source.title}:`, {
          error: errorMessage,
          stack: errorStack,
          contentLength: content.length,
        });
      }

      // Try one more time with a very simple fallback
      if (sanitizedContent.length > 200 && source.snippet) {
        const simpleFinding = {
          content: this.sanitizeContentForLLM(source.snippet).substring(0, 300).trim() + '...',
          relevance: 0.4,
          confidence: 0.5,
          category: 'fact' as const,
        };

        elizaLogger.info(`[ResearchService] Using snippet as fallback finding for ${source.title}`);
        return [simpleFinding];
      }

      // Return empty array - the caller will handle sources with no findings
      return [];
    }
  }

  // Service lifecycle methods
  async stop(): Promise<void> {
    // Abort all active research
    for (const [projectId, controller] of this.activeResearch) {
      controller.abort();
      const project = this.projects.get(projectId);
      if (project) {
        project.status = ResearchStatus.PAUSED;
      }
    }
    this.activeResearch.clear();
    // Explicitly return void
    return;
  }

  async getProject(projectId: string): Promise<ResearchProject | undefined> {
    return this.projects.get(projectId);
  }

  async getAllProjects(): Promise<ResearchProject[]> {
    return Array.from(this.projects.values());
  }

  async getActiveProjects(): Promise<ResearchProject[]> {
    return Array.from(this.projects.values()).filter((p) => p.status === ResearchStatus.ACTIVE);
  }
}
