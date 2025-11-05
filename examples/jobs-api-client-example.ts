/**
 * Jobs API Client Usage Examples
 * 
 * This example demonstrates various ways to use the Jobs API through the ElizaOS API client.
 * The Jobs API provides a simplified request/response pattern for one-off agent interactions.
 */

import { ElizaClient, JobStatus } from '@elizaos/api-client';

// Initialize the client
const client = ElizaClient.create({
    baseUrl: 'http://localhost:3000',
    apiKey: process.env.ELIZA_SERVER_AUTH_TOKEN, // Optional
});

// Example user and agent IDs (replace with your actual IDs)
const userId = '00000000-0000-0000-0000-000000000001';
const agentId = '00000000-0000-0000-0000-000000000002';

/**
 * Example 1: Simple ask pattern
 * The easiest way to get a response from an agent
 */
async function example1_simpleAsk() {
    console.log('\n=== Example 1: Simple Ask Pattern ===');

    try {
        const response = await client.jobs.ask(
            userId,
            'What is the price of Bitcoin?'
        );
        console.log('Agent response:', response);
    } catch (error) {
        console.error('Error:', error.message);
    }
}

/**
 * Example 2: Create and poll with full control
 * Get access to job metadata, processing time, etc.
 */
async function example2_createAndPoll() {
    console.log('\n=== Example 2: Create and Poll with Full Control ===');

    try {
        const result = await client.jobs.createAndPoll({
            userId,
            content: 'Analyze the current DeFi market trends',
            agentId, // Optional - target specific agent
            timeoutMs: 60000, // Optional - 60 second timeout
            metadata: { source: 'example-script' },
        }, {
            interval: 1000, // Poll every second
            onProgress: (job, attempt) => {
                console.log(`Attempt ${attempt}: Status = ${job.status}`);
            },
        });

        if (result.success) {
            console.log('Response:', result.job.result?.message.content);
            console.log('Processing time:', result.job.result?.processingTimeMs, 'ms');
            console.log('Total attempts:', result.attempts);
        } else {
            console.error('Job failed:', result.job.error);
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

/**
 * Example 3: Exponential backoff for long-running queries
 * More efficient for queries that might take longer
 */
async function example3_exponentialBackoff() {
    console.log('\n=== Example 3: Exponential Backoff ===');

    try {
        const result = await client.jobs.createAndPollWithBackoff({
            userId,
            content: 'Perform a comprehensive market analysis across multiple chains',
            timeoutMs: 120000, // 2 minutes
        }, {
            initialInterval: 500, // Start with 500ms
            maxInterval: 5000, // Max 5 seconds between polls
            multiplier: 1.5, // Increase interval by 1.5x each time
            maxAttempts: 60,
            onProgress: (job, attempt) => {
                console.log(`[${attempt}] Status: ${job.status}`);
            },
        });

        if (result.success) {
            console.log('Success! Response:', result.job.result?.message.content);
            console.log('Time taken:', result.timeMs, 'ms');
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

/**
 * Example 4: Manual job creation and polling
 * For cases where you need fine-grained control
 */
async function example4_manualControl() {
    console.log('\n=== Example 4: Manual Control ===');

    try {
        // Create the job
        const job = await client.jobs.create({
            userId,
            content: 'What are the top DeFi protocols?',
        });

        console.log('Job created:', job.jobId);
        console.log('Initial status:', job.status);

        // Poll manually
        const result = await client.jobs.poll(job.jobId, {
            interval: 1000,
            maxAttempts: 30,
        });

        console.log('Final status:', result.job.status);
        if (result.success) {
            console.log('Response:', result.job.result?.message.content);
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

/**
 * Example 5: Batch processing multiple questions
 */
async function example5_batchQuestions() {
    console.log('\n=== Example 5: Batch Questions ===');

    const questions = [
        'What is Bitcoin?',
        'What is Ethereum?',
        'What is DeFi?',
    ];

    try {
        // Create all jobs
        const jobPromises = questions.map(question =>
            client.jobs.create({
                userId,
                content: question,
            })
        );

        const jobs = await Promise.all(jobPromises);
        console.log(`Created ${jobs.length} jobs`);

        // Poll all jobs in parallel
        const resultPromises = jobs.map(job =>
            client.jobs.poll(job.jobId, { interval: 1000 })
        );

        const results = await Promise.all(resultPromises);

        // Display results
        results.forEach((result, index) => {
            console.log(`\nQ: ${questions[index]}`);
            if (result.success) {
                console.log(`A: ${result.job.result?.message.content}`);
            } else {
                console.log(`Error: ${result.job.error}`);
            }
        });
    } catch (error) {
        console.error('Error:', error.message);
    }
}

/**
 * Example 6: List and manage jobs
 */
async function example6_listAndManage() {
    console.log('\n=== Example 6: List and Manage Jobs ===');

    try {
        // Get completed jobs
        const completedJobs = await client.jobs.list({
            status: JobStatus.COMPLETED,
            limit: 5,
        });

        console.log(`Found ${completedJobs.jobs.length} completed jobs (of ${completedJobs.total} total)`);

        completedJobs.jobs.forEach(job => {
            console.log('\nJob:', job.jobId);
            console.log('Prompt:', job.prompt);
            console.log('Processing time:', job.result?.processingTimeMs, 'ms');
        });

        // Get all recent jobs
        const allJobs = await client.jobs.list({ limit: 10 });
        console.log(`\nTotal jobs in system: ${allJobs.total}`);
    } catch (error) {
        console.error('Error:', error.message);
    }
}

/**
 * Example 7: Health monitoring
 */
async function example7_healthMonitoring() {
    console.log('\n=== Example 7: Health Monitoring ===');

    try {
        const health = await client.jobs.health();

        console.log('System Health:', health.healthy ? 'HEALTHY' : 'UNHEALTHY');
        console.log('Total Jobs:', health.totalJobs);
        console.log('\nStatus Breakdown:');
        console.log('  Pending:', health.statusCounts.pending);
        console.log('  Processing:', health.statusCounts.processing);
        console.log('  Completed:', health.statusCounts.completed);
        console.log('  Failed:', health.statusCounts.failed);
        console.log('  Timeout:', health.statusCounts.timeout);
        console.log('\nMetrics:');
        console.log('  Average processing time:', health.metrics.averageProcessingTimeMs, 'ms');
        console.log('  Success rate:', (health.metrics.successRate * 100).toFixed(2), '%');
        console.log('  Failure rate:', (health.metrics.failureRate * 100).toFixed(2), '%');
        console.log('  Timeout rate:', (health.metrics.timeoutRate * 100).toFixed(2), '%');
    } catch (error) {
        console.error('Error:', error.message);
    }
}

/**
 * Example 8: Error handling patterns
 */
async function example8_errorHandling() {
    console.log('\n=== Example 8: Error Handling ===');

    // Pattern 1: Try-catch with ask
    try {
        const response = await client.jobs.ask(userId, 'Test question');
        console.log('Response:', response);
    } catch (error) {
        console.error('Failed to get response:', error.message);
    }

    // Pattern 2: Check result success
    const result = await client.jobs.createAndPoll({
        userId,
        content: 'Another test',
    });

    if (result.success) {
        console.log('Success:', result.job.result?.message.content);
    } else {
        console.error('Job failed with status:', result.job.status);
        if (result.job.error) {
            console.error('Error message:', result.job.error);
        }
    }

    // Pattern 3: Manual status checking
    const createResult = await client.jobs.create({
        userId,
        content: 'Manual check',
    });

    const pollResult = await client.jobs.poll(createResult.jobId, {
        interval: 1000,
        maxAttempts: 5,
    });

    switch (pollResult.job.status) {
        case JobStatus.COMPLETED:
            console.log('Completed successfully');
            break;
        case JobStatus.FAILED:
            console.error('Job failed:', pollResult.job.error);
            break;
        case JobStatus.TIMEOUT:
            console.error('Job timed out');
            break;
        default:
            console.log('Job still processing after max attempts');
    }
}

/**
 * Main function to run all examples
 */
async function main() {
    console.log('Jobs API Client Examples');
    console.log('========================\n');

    // Run examples (comment out the ones you don't want to run)
    await example1_simpleAsk();
    await example2_createAndPoll();
    await example3_exponentialBackoff();
    await example4_manualControl();
    await example5_batchQuestions();
    await example6_listAndManage();
    await example7_healthMonitoring();
    await example8_errorHandling();

    console.log('\n=== All examples completed ===');
}

// Run if executed directly
if (import.meta.main) {
    main().catch(console.error);
}

