/**
 * PATTERN DETECTION UTILITIES
 *
 * Responsibilities:
 * - V1 pattern detection in TypeScript files
 * - Pattern classification and reporting
 * - Support for migration decision making
 * - Provider-specific pattern detection
 */

export interface V1Pattern {
  pattern: RegExp;
  found: boolean;
  name: string;
}

export interface PatternDetectionResult {
  hasV1Patterns: boolean;
  detectedPatterns: string[];
  patterns: V1Pattern[];
}

export class PatternDetection {
  /**
   * Detect V1 patterns in file content
   */
  detectV1Patterns(content: string): PatternDetectionResult {
    // Enhanced V1 pattern detection from plugin-news analysis and provider migration guide
    const v1Patterns: V1Pattern[] = [
      // Core V1 patterns
      { pattern: /ModelClass/g, found: false, name: 'ModelClass usage' },
      { pattern: /elizaLogger/g, found: false, name: 'elizaLogger usage' },
      { pattern: /composeContext/g, found: false, name: 'composeContext usage' },
      {
        pattern: /generateObjectDeprecated/g,
        found: false,
        name: 'generateObjectDeprecated usage',
      },
      {
        pattern: /generateObject\(/g,
        found: false,
        name: 'generateObject usage',
      },
      {
        pattern: /runtime\.updateRecentMessageState/g,
        found: false,
        name: 'updateRecentMessageState usage',
      },
      { pattern: /runtime\.memory\.create/g, found: false, name: 'memory.create usage' },
      {
        pattern: /runtime\.messageManager\.createMemory/g,
        found: false,
        name: 'messageManager usage',
      },
      { pattern: /runtime\.language\.generateText/g, found: false, name: 'generateText usage' },
      { pattern: /user:\s*["']/g, found: false, name: 'role property in examples' },
      { pattern: /role:\s*["']/g, found: false, name: 'role property' },
      { pattern: /stop:\s*\[/g, found: false, name: 'stop parameter' },
      { pattern: /max_tokens:/g, found: false, name: 'max_tokens parameter' },
      { pattern: /frequency_penalty:/g, found: false, name: 'frequency_penalty parameter' },
      {
        pattern: /import\s+{\s*type\s+\w+\s*}/g,
        found: false,
        name: 'type imports needing conversion',
      },
      { pattern: /import\s+{[^}]*,\s*type\s+[^}]+}/g, found: false, name: 'mixed imports' },
      { pattern: /state:\s*{}\s*[,)]/g, found: false, name: 'empty State objects' },
      { pattern: /\sany\s*[,)]/g, found: false, name: 'any type usage' },
      { pattern: /Promise<boolean>/g, found: false, name: 'Promise<boolean> return type' },
      { pattern: /static serviceType:\s*ServiceType/g, found: false, name: 'explicit ServiceType' },
      { pattern: /private config:/g, found: false, name: 'private config field' },
      { pattern: /z\.number\(\)/g, found: false, name: 'non-coerced Zod numbers' },

      // NEW: State structure patterns from knowledge base
      {
        pattern: /state\.tokenA(?!\s*=)/g,
        found: false,
        name: 'direct state.tokenA access (should be state.values.tokenA)',
      },
      {
        pattern: /state\.amount(?!\s*=)/g,
        found: false,
        name: 'direct state.amount access (should be state.values.amount)',
      },
      {
        pattern: /state\.slippage(?!\s*=)/g,
        found: false,
        name: 'direct state.slippage access (should be state.data.slippage)',
      },
      {
        pattern: /state\.fromChain(?!\s*=)/g,
        found: false,
        name: 'direct state.fromChain access (should be state.values.fromChain)',
      },
      {
        pattern: /state\.proposalId(?!\s*=)/g,
        found: false,
        name: 'direct state.proposalId access (should be state.values.proposalId)',
      },
      {
        pattern: /state\.tokenId(?!\s*=)/g,
        found: false,
        name: 'direct state.tokenId access (should be state.values.tokenId)',
      },
      {
        pattern: /state\.walletAddress(?!\s*=)/g,
        found: false,
        name: 'direct state.walletAddress access (should be state.values.walletAddress)',
      },
      {
        pattern: /state\.balances(?!\s*=)/g,
        found: false,
        name: 'direct state.balances access (should be state.data.balances)',
      },
      {
        pattern: /state\.validator(?!\s*=)/g,
        found: false,
        name: 'direct state.validator access (should be state.data.validator)',
      },

      // NEW: State persistence patterns
      {
        pattern: /state\.\w+\s*=(?!\s*state\.(values|data))/g,
        found: false,
        name: 'direct state property assignment (should use state.values or state.data)',
      },

      // NEW: ActionExample format patterns
      {
        pattern: /user:\s*["']user["']/g,
        found: false,
        name: 'ActionExample using user field instead of name',
      },
      {
        pattern: /examples:\s*\[\s*\[\s*{\s*user:/g,
        found: false,
        name: 'ActionExample structure with user field',
      },
      {
        pattern: /{\s*user:\s*["']\w+["'],\s*content:/g,
        found: false,
        name: 'ActionExample user field pattern',
      },

      // NEW: Content interface patterns
      {
        pattern: /text:\s*\w+,\s*action:/g,
        found: false,
        name: 'Content using action field instead of actions array',
      },
      {
        pattern: /action:\s*["']\w+["']/g,
        found: false,
        name: 'Content with single action field',
      },
      {
        pattern: /callback\(\{\s*text:\s*[^,}]+,\s*action:/g,
        found: false,
        name: 'callback with action field instead of actions array',
      },

      // NEW: Handler signature patterns
      {
        pattern: /handler:\s*async\s*\([^)]*\):\s*Promise<boolean>/g,
        found: false,
        name: 'handler with Promise<boolean> return type',
      },
      {
        pattern: /state:\s*State\s*\|\s*undefined/g,
        found: false,
        name: 'handler with State | undefined parameter',
      },
      {
        pattern: /callback\?:/g,
        found: false,
        name: 'optional callback parameter in handler',
      },
      {
        pattern: /options\s*=\s*{}/g,
        found: false,
        name: 'options parameter with default empty object',
      },
      {
        pattern: /handler:\s*async\s*\([^)]*\)\s*=>/g,
        found: false,
        name: 'handler missing responses parameter',
      },

      // NEW: Memory creation patterns
      {
        pattern: /runtime\.messageManager\.createMemory/g,
        found: false,
        name: 'V1 messageManager.createMemory pattern',
      },
      {
        pattern: /runtime\.memory\.create/g,
        found: false,
        name: 'V1 memory.create pattern',
      },
      {
        pattern: /createMemory\([^)]*\)\s*(?!,\s*['"`]messages['"`])/g,
        found: false,
        name: 'createMemory without table name parameter',
      },

      // NEW: Model usage patterns
      {
        pattern: /ModelClass\.LARGE/g,
        found: false,
        name: 'ModelClass.LARGE usage (should be ModelType.TEXT_LARGE)',
      },
      {
        pattern: /ModelClass\.\w+/g,
        found: false,
        name: 'ModelClass enum usage',
      },
      {
        pattern: /modelClass:\s*ModelClass/g,
        found: false,
        name: 'modelClass parameter usage',
      },
      {
        pattern: /context:\s*\w+,\s*modelClass:/g,
        found: false,
        name: 'V1 model generation pattern with context and modelClass',
      },

      // Additional patterns from plugin-news migration
      { pattern: /import\s+{\s*TestSuite\s*}/g, found: false, name: 'TestSuite value import' },
      { pattern: /import\s+{\s*AgentTest/g, found: false, name: 'AgentTest import' },
      {
        pattern: /export\s+(const|let|var)\s+testSuite/g,
        found: false,
        name: 'testSuite export name',
      },
      { pattern: /_options:\s*any/g, found: false, name: 'options any type' },
      { pattern: /context:\s*["']/g, found: false, name: 'context parameter in useModel' },
      { pattern: /model:\s*ModelType/g, found: false, name: 'model in options object' },
      {
        pattern: /import\s+{\s*(\w+),\s*type\s+(\w+)\s*}\s+from\s+["']@elizaos\/core["']/g,
        found: false,
        name: 'mixed @elizaos/core imports',
      },
      { pattern: /state\s*\|\s*undefined/g, found: false, name: 'State | undefined type' },
      { pattern: /callback\?:/g, found: false, name: 'optional callback parameter' },
      { pattern: /options.*=\s*{}/g, found: false, name: 'options default empty object' },

      // PROVIDER-SPECIFIC V1 PATTERNS
      // External dependency patterns
      {
        pattern:
          /import\s+{\s*DeriveKeyProvider,?\s*TEEMode\s*}\s+from\s+["']@elizaos\/plugin-tee["']/g,
        found: false,
        name: 'external TEE plugin dependency',
      },
      {
        pattern: /import\s+NodeCache\s+from\s+["']node-cache["']/g,
        found: false,
        name: 'NodeCache dependency',
      },
      {
        pattern: /import\s+{\s*ICacheManager\s*}\s+from/g,
        found: false,
        name: 'ICacheManager import',
      },
      {
        pattern: /import\s+{\s*[^}]*ExternalServiceProvider[^}]*\s*}/g,
        found: false,
        name: 'external service provider import',
      },

      // Constructor patterns
      {
        pattern: /constructor\([^)]*private\s+cacheManager:\s*ICacheManager/g,
        found: false,
        name: 'ICacheManager constructor parameter',
      },
      {
        pattern: /constructor\([^)]*cacheManager:\s*ICacheManager/g,
        found: false,
        name: 'cacheManager parameter',
      },

      // Caching patterns
      {
        pattern: /private\s+cache:\s*NodeCache/g,
        found: false,
        name: 'NodeCache property',
      },
      {
        pattern: /new\s+NodeCache\(/g,
        found: false,
        name: 'NodeCache instantiation',
      },
      {
        pattern: /private\s+CACHE_EXPIRY_SEC\s*=/g,
        found: false,
        name: 'cache expiry constant',
      },
      {
        pattern: /this\.cache\.get</g,
        found: false,
        name: 'NodeCache get method',
      },
      {
        pattern: /this\.cache\.set\(/g,
        found: false,
        name: 'NodeCache set method',
      },
      {
        pattern: /getCachedData<[^>]*>\(/g,
        found: false,
        name: 'manual cache data retrieval',
      },
      {
        pattern: /setCachedData<[^>]*>\(/g,
        found: false,
        name: 'manual cache data storage',
      },

      // Single context patterns
      {
        pattern: /private\s+currentContext:\s*\w+\s*=/g,
        found: false,
        name: 'single context property',
      },
      {
        pattern: /getCurrentContext\(\):\s*\w+/g,
        found: false,
        name: 'getCurrentContext method',
      },
      {
        pattern: /setCurrentContext\s*=/g,
        found: false,
        name: 'setCurrentContext method',
      },
      {
        pattern: /switchContext\(/g,
        found: false,
        name: 'switchContext method',
      },

      // Provider response patterns
      {
        pattern: /async\s+get\([^)]*\):\s*Promise<string\s*\|\s*null>/g,
        found: false,
        name: 'provider returning string | null',
      },
      {
        pattern: /async\s+get\([^)]*\):\s*Promise<[^>]*>\s*{[^}]*return\s+`[^`]*`/g,
        found: false,
        name: 'provider returning template literal',
      },
      {
        pattern: /return\s+null;\s*}\s*catch/g,
        found: false,
        name: 'provider returning null on error',
      },

      // Service initialization patterns
      {
        pattern: /new\s+DeriveKeyProvider\(/g,
        found: false,
        name: 'external TEE provider instantiation',
      },
      {
        pattern: /new\s+\w*ServiceProvider\(/g,
        found: false,
        name: 'external service provider instantiation',
      },

      // Configuration patterns
      {
        pattern: /runtime\.character\.settings\.\w+\s+as\s+\w+\[\]/g,
        found: false,
        name: 'direct character settings access',
      },
      {
        pattern: /\|\|\s*\[\]/g,
        found: false,
        name: 'fallback to empty array pattern',
      },

      // Method signature patterns
      {
        pattern: /async\s+get\w+\(\):\s*Promise<[^>]*\s*\|\s*null>/g,
        found: false,
        name: 'single resource getter method',
      },
      {
        pattern: /readFromCache<[^>]*>\(/g,
        found: false,
        name: 'cache read method',
      },
      {
        pattern: /writeToCache<[^>]*>\(/g,
        found: false,
        name: 'cache write method',
      },

      // Provider interface patterns
      {
        pattern: /export\s+interface\s+\w*Provider\s*{/g,
        found: false,
        name: 'custom provider interface',
      },
      {
        pattern: /type:\s*string;/g,
        found: false,
        name: 'provider type property',
      },
      {
        pattern: /initialize:\s*\([^)]*\)\s*=>\s*Promise<void>/g,
        found: false,
        name: 'provider initialize method',
      },
      {
        pattern: /validate:\s*\([^)]*\)\s*=>\s*Promise<boolean>/g,
        found: false,
        name: 'provider validate method',
      },

      // External API patterns
      {
        pattern: /from\s+["']@\w+\/plugin-\w+["']/g,
        found: false,
        name: 'external plugin import',
      },

      // Legacy patterns
      {
        pattern: /TEEMode\./g,
        found: false,
        name: 'TEE mode enumeration usage',
      },
      {
        pattern: /\.deriveEd25519PrivateKey\(/g,
        found: false,
        name: 'external key derivation method',
      },
    ];

    // Check for V1 patterns
    let hasV1Patterns = false;
    for (const p of v1Patterns) {
      if (p.pattern.test(content)) {
        p.found = true;
        hasV1Patterns = true;
      }
    }

    const detectedPatterns = v1Patterns.filter((p) => p.found).map((p) => p.name);

    return {
      hasV1Patterns,
      detectedPatterns,
      patterns: v1Patterns,
    };
  }

  /**
   * Check if content has specific pattern types
   */
  hasPattern(content: string, patternType: string): boolean {
    const result = this.detectV1Patterns(content);
    return result.detectedPatterns.some((name) => name.includes(patternType));
  }

  /**
   * Check if content has provider-specific patterns
   */
  hasProviderPatterns(content: string): boolean {
    const result = this.detectV1Patterns(content);
    const providerPatterns = [
      'external TEE plugin dependency',
      'NodeCache dependency',
      'ICacheManager import',
      'cacheManager parameter',
      'single context property',
      'provider returning string | null',
      'external service provider',
      'custom provider interface',
    ];
    return result.detectedPatterns.some((name) =>
      providerPatterns.some((pattern) => name.includes(pattern))
    );
  }

  /**
   * Check if content has external dependency patterns
   */
  hasExternalDependencies(content: string): boolean {
    const result = this.detectV1Patterns(content);
    const externalPatterns = [
      'external TEE plugin dependency',
      'external service provider',
      'NodeCache dependency',
      'external plugin import',
    ];
    return result.detectedPatterns.some((name) =>
      externalPatterns.some((pattern) => name.includes(pattern))
    );
  }

  /**
   * Check if content has state structure patterns
   */
  hasStateStructurePatterns(content: string): boolean {
    const result = this.detectV1Patterns(content);
    const statePatterns = [
      'direct state property access',
      'direct state property assignment',
      'direct state.tokenA access',
      'direct state.amount access',
      'direct state.slippage access',
      'direct state.fromChain access',
      'direct state.proposalId access',
      'direct state.tokenId access',
      'direct state.walletAddress access',
      'direct state.balances access',
      'direct state.validator access',
    ];
    return result.detectedPatterns.some((name) =>
      statePatterns.some((pattern) => name.includes(pattern))
    );
  }

  /**
   * Check if content has ActionExample format issues
   */
  hasActionExamplePatterns(content: string): boolean {
    const result = this.detectV1Patterns(content);
    const actionExamplePatterns = [
      'ActionExample using user field',
      'ActionExample structure with user field',
      'ActionExample user field pattern',
    ];
    return result.detectedPatterns.some((name) =>
      actionExamplePatterns.some((pattern) => name.includes(pattern))
    );
  }

  /**
   * Check if content has Content interface issues
   */
  hasContentInterfacePatterns(content: string): boolean {
    const result = this.detectV1Patterns(content);
    const contentPatterns = [
      'Content using action field',
      'Content with single action field',
      'callback with action field',
    ];
    return result.detectedPatterns.some((name) =>
      contentPatterns.some((pattern) => name.includes(pattern))
    );
  }

  /**
   * Check if content has handler signature issues
   */
  hasHandlerSignaturePatterns(content: string): boolean {
    const result = this.detectV1Patterns(content);
    const handlerPatterns = [
      'Promise<boolean> return type',
      'State | undefined type',
      'optional callback parameter',
      'options default empty object',
      'handler missing responses parameter',
    ];
    return result.detectedPatterns.some((name) =>
      handlerPatterns.some((pattern) => name.includes(pattern))
    );
  }

  /**
   * Get pattern statistics
   */
  getPatternStats(content: string): { total: number; found: number; percentage: number } {
    const result = this.detectV1Patterns(content);
    const total = result.patterns.length;
    const found = result.detectedPatterns.length;
    const percentage = total > 0 ? (found / total) * 100 : 0;

    return { total, found, percentage };
  }
}
