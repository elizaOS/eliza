import { RAGService, Document } from './vector/index.js';
import { TelemetryService } from './telemetry/index.js';

/**
 * Test script for the RAG (Retrieval Augmented Generation) system
 * Demonstrates the dual embeddings approach with sample documents
 */
async function testRAGSystem() {
  console.log('\n===== Testing Dual Embeddings RAG System =====');

  // Create a RAG service with custom configuration
  const ragService = new RAGService({
    embeddingDimension: 384,
    maxResults: 5,
    similarityThreshold: 0.01, // Very low threshold to ensure we see all matches
    combinedWeights: { title: 0.5, content: 0.5 }, // Equal weighting
    testMode: true, // Enable test mode for differentiated embeddings
  });

  console.log('RAG service initialized successfully');

  // Sample documents for our knowledge base
  const sampleDocuments: Document[] = [
    {
      id: 'doc1',
      title: 'How to optimize TypeScript compilation',
      content:
        'TypeScript compilation can be optimized by using incremental compilation, project references, and excluding test files. You can configure these options in tsconfig.json.',
      tags: ['typescript', 'performance', 'compilation'],
    },
    {
      id: 'doc9',
      title: 'TypeScript Optimization Techniques',
      content:
        'Improve TypeScript performance with these techniques: use incremental compilation, configure project references, enable skipLibCheck, optimize module resolution, exclude test files, and employ declaration-only imports. These changes can significantly speed up your build process.',
      tags: ['typescript', 'optimization', 'techniques', 'performance'],
    },
    {
      id: 'doc2',
      title: 'Understanding React useState hook',
      content:
        'The useState hook in React allows functional components to manage state. It returns a state value and a function to update it. The update function can accept a new value or a function that receives the previous state.',
      tags: ['react', 'hooks', 'state-management'],
    },
    {
      id: 'doc3',
      title: 'Async/await best practices in JavaScript',
      content:
        'When using async/await in JavaScript, always handle errors with try/catch blocks, avoid unnecessary async functions, and be careful with Promise.all for concurrent operations. Use Promise.allSettled when you need to wait for all promises regardless of rejection.',
      tags: ['javascript', 'async', 'promises'],
    },
    {
      id: 'doc4',
      title: 'Setting up a Node.js project with TypeScript',
      content:
        'To set up a Node.js project with TypeScript, install typescript, ts-node, and @types/node. Create a tsconfig.json file with appropriate configuration. Use npm scripts to build and run your TypeScript code.',
      tags: ['typescript', 'nodejs', 'setup'],
    },
    {
      id: 'doc5',
      title: 'Optimizing React performance with memoization',
      content:
        'Improve React performance by using React.memo for functional components, useMemo for expensive calculations, and useCallback for function references. This prevents unnecessary re-renders by memoizing values and functions.',
      tags: ['react', 'performance', 'optimization'],
    },
    {
      id: 'doc6',
      title: 'CSS Grid vs Flexbox: When to use each',
      content:
        'CSS Grid is ideal for two-dimensional layouts (rows and columns), while Flexbox works best for one-dimensional layouts (either rows OR columns). Use Grid for page layouts and complex grid systems, and Flexbox for UI elements and simple alignment tasks.',
      tags: ['css', 'layout', 'design'],
    },
    {
      id: 'doc7',
      title: 'JavaScript Promise error handling patterns',
      content:
        'Handle JavaScript Promise errors by using .catch() at the end of promise chains, or try/catch with async/await. For grouped promises, use Promise.all with a wrapping try/catch or individual .catch handlers on each promise.',
      tags: ['javascript', 'promises', 'error-handling'],
    },
    {
      id: 'doc8',
      title: 'TypeScript advanced type usage',
      content:
        'TypeScript advanced types include mapped types, conditional types, and template literal types. Use utility types like Partial<T>, Required<T>, Pick<T, K>, and Omit<T, K> to manipulate existing types without creating new interfaces.',
      tags: ['typescript', 'types', 'advanced'],
    },
  ];

  // Add documents to the RAG service
  console.log(`Adding ${sampleDocuments.length} documents to the knowledge base...`);
  await ragService.addDocuments(sampleDocuments);
  console.log(`Knowledge base now contains ${ragService.getDocumentCount()} documents`);

  // Perform searches using different modes to demonstrate dual embeddings

  // Test 1: Search by combined mode (default, uses both title and content embeddings)
  console.log('\n--- Test 1: Combined Search (title + content) ---');
  const combinedQuery = 'typescript optimization techniques';
  console.log(`Query: "${combinedQuery}"`);

  const combinedResults = await ragService.search(combinedQuery);
  console.log(
    `Found ${combinedResults.results.length} results in ${combinedResults.telemetry.latencyMs.toFixed(2)}ms`
  );

  // Display results
  combinedResults.results.forEach((result, index) => {
    console.log(
      `\nResult ${index + 1} (Score: ${result.score.toFixed(4)}, Matched on: ${result.matchedOn})`
    );
    console.log(`Title: ${result.document.title}`);
    console.log(`Content: ${result.document.content.substring(0, 100)}...`);
  });

  // Test 2: Search optimized for title matching
  console.log('\n--- Test 2: Title-Optimized Search ---');
  const titleQuery = 'react hooks';
  console.log(`Query: "${titleQuery}"`);

  const titleResults = await ragService.searchByTitle(titleQuery);
  console.log(
    `Found ${titleResults.results.length} results in ${titleResults.telemetry.latencyMs.toFixed(2)}ms`
  );

  // Display results
  titleResults.results.forEach((result, index) => {
    console.log(
      `\nResult ${index + 1} (Score: ${result.score.toFixed(4)}, Matched on: ${result.matchedOn})`
    );
    console.log(`Title: ${result.document.title}`);
    console.log(`Content: ${result.document.content.substring(0, 100)}...`);
  });

  // Test 3: Search optimized for content matching
  console.log('\n--- Test 3: Content-Optimized Search ---');
  const contentQuery = 'error handling with promises and async/await';
  console.log(`Query: "${contentQuery}"`);

  const contentResults = await ragService.searchByContent(contentQuery);
  console.log(
    `Found ${contentResults.results.length} results in ${contentResults.telemetry.latencyMs.toFixed(2)}ms`
  );

  // Display results
  contentResults.results.forEach((result, index) => {
    console.log(
      `\nResult ${index + 1} (Score: ${result.score.toFixed(4)}, Matched on: ${result.matchedOn})`
    );
    console.log(`Title: ${result.document.title}`);
    console.log(`Content: ${result.document.content.substring(0, 100)}...`);
  });

  // Get telemetry report
  const telemetry = TelemetryService.getInstance();
  const metrics = telemetry.getMetricsSummary();

  console.log('\n--- Telemetry Metrics Summary ---');
  console.log(JSON.stringify(metrics, null, 2));

  // Clean up
  telemetry.flush();
  console.log('\n===== RAG System Test Complete =====');
}

// Run the test
testRAGSystem().catch((error) => {
  console.error('Error during RAG system test:', error);
  process.exit(1);
});
