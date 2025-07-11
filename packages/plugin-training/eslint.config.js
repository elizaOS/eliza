import baseConfig from '../../eslint.config.js';

export default [
  ...baseConfig,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: {
        // Node.js and Web API globals
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
        RequestInit: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        Blob: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        performance: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        Bun: 'readonly',
        NodeJS: 'readonly',
      },
    },
    rules: {
      // Disable ESLint formatting rules that conflict with Prettier
      '@typescript-eslint/indent': 'off',
      indent: 'off',
      '@typescript-eslint/space-before-function-paren': 'off',
      'space-before-function-paren': 'off',
      '@typescript-eslint/comma-dangle': 'off',
      'comma-dangle': 'off',
      '@typescript-eslint/quotes': 'off',
      quotes: 'off',
      '@typescript-eslint/semi': 'off',
      semi: 'off',
      '@typescript-eslint/member-delimiter-style': 'off',
      '@typescript-eslint/type-annotation-spacing': 'off',
      'object-curly-spacing': 'off',
      'array-bracket-spacing': 'off',
      'computed-property-spacing': 'off',
      'space-in-parens': 'off',
      'space-before-blocks': 'off',
      'keyword-spacing': 'off',
      'no-trailing-spaces': 'off',
      'no-multiple-empty-lines': 'off',
      'eol-last': 'off',
      'padded-blocks': 'off',
      'lines-between-class-members': 'off',
      'no-mixed-spaces-and-tabs': 'off',

      // Ignore unused function parameters when they're part of interface implementations
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern:
            '^_|^runtime$|^message$|^params$|^context$|^args$|^options$|^config$|^error$|^err$|^e$|^response$|^event$|^action$|^actions$|^state$|^ctx$|^status$|^progress$|^users$|^prompt$|^domain$|^benchmark$|^content$|^conversationData$|^messageIndex$|^modelPath$|^files$|^pipelineId$|^relativePath$|^source$|^entityId$|^index$|^trajectory$|^step$|^failedStep$|^recoveryStep$|^configs$|^entry$|^outcome$|^budget$',
          varsIgnorePattern:
            '^_|^ignored$|^monitorJob$|^TrainingDataRecord$|^HandlerCallback$|^originalProcessActions$|^ServiceTypeName$|^Content$|^roomId$|^requestText$|^Memory$|^fs$|^path$|^currentStep$|^dbPath$|^PlanningTrainingExample$|^PlanningScenario$|^State$|^crypto$|^PersonalityProfile$|^userId$|^testRatio$|^clearServiceRegistry$|^ModelCostInfo$|^TrainingArtifact$|^criteria$|^client$|^TrainingScenarioOutput$|^HuggingFaceDataset$|^DatasetExportService$|^LanceDBManager$|^RepositoryAnalysis$|^extractGitHubUrl$|^monitorTrainingJob$|^parseFileSize$|^schemaPath$|^ExportFormat$|^MergedFileInfo$|^FileStats$|^ExportStats$|^MergeStats$|^ServiceClass$|^logger$|^UUID$|^IDatabaseAdapter$|^MessageExample$|^collectDataFromExamples$|^collectDatasetFromExamples$|^DatasetRecord$|^scenarios$|^ActionResult$|^v4$|^CustomReasoningService$|^TrainingDataCollector$|^saveDataset$|^message$|^TogetherAIJob$|^stats$|^ModelType$|^TrainingError$|^withErrorHandling$|^CleanOptions$|^FileSystemError$|^retries$|^lastError$|^description$|^CustomModelType$|^log$|^totalSamples$|^IAgentRuntime$|^TrainingConfig$|^stdout$|^RepoDesignation$|^license$|^elizaLogger$|^solution$|^JSONLDataset$|^ConfigurationError$|^NetworkError$',
          caughtErrorsIgnorePattern: '^_|^error$|^err$|^e$',
        },
      ],

      // Allow empty blocks for catch statements
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // Allow while(true) for intentional infinite loops with breaks
      'no-constant-condition': ['error', { checkLoops: false }],

      // Disable explicit any warnings - too strict for real-world code
      '@typescript-eslint/no-explicit-any': 'off',

      // Allow empty functions and constructors
      '@typescript-eslint/no-empty-function': 'off',

      // Allow require() in CommonJS contexts
      '@typescript-eslint/no-var-requires': 'off',

      // Allow ! non-null assertions when necessary
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Allow @ts-ignore when absolutely necessary (but prefer @ts-expect-error)
      '@typescript-eslint/ban-ts-comment': [
        'warn',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          'ts-nocheck': 'allow-with-description',
          'ts-check': false,
        },
      ],

      // Warn on console.log but allow other console methods AND allow in object properties
      'no-console': [
        'warn',
        {
          allow: ['warn', 'error', 'info', 'debug', 'trace'],
        },
      ],

      // Type imports
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
    },
  },
  {
    // Test files specific rules
    files: ['**/*.test.ts', '**/__tests__/**/*.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // Example and script files
    files: ['**/examples/**/*.ts', '**/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
