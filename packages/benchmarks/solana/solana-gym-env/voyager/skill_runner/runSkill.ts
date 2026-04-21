import path from 'path';

type SkillExecutionResult = string;

async function runSkill(): Promise<void> {
    const [, , filePath, timeoutMsStr, agentPubkey, latestBlockhash] = process.argv;

    if (!filePath || !timeoutMsStr) {
        console.error('Usage: bun runSkill.ts <file> <timeoutMs> [agentPubkey] [latestBlockhash]');
        process.exit(1);
    }

    const timeoutMs = parseInt(timeoutMsStr, 10);
    const absolutePath = path.resolve(filePath);


    try {
        const skillModule = await import(absolutePath);

        if (typeof skillModule.executeSkill !== 'function') {
            throw new Error('executeSkill function not found in the provided module.');
        }

        const serialized_tx: SkillExecutionResult = await Promise.race([
            skillModule.executeSkill(latestBlockhash),
            new Promise<SkillExecutionResult>((_, reject) =>
                setTimeout(() => reject(new Error('Skill execution timed out.')), timeoutMs)
            ),
        ]);

        console.log(JSON.stringify({
            serialized_tx,
        }));
    } catch (error: any) {
        // First, let Bun print the actual error with its formatting to stderr
        console.error(error);

        // Extract error message - handle both regular errors and Bun's syntax errors
        let errorMessage = 'An unknown error occurred.';
        let errorDetails: string[] = [];

        // Check if this is an AggregateError (Bun's compilation errors)
        if (error?.name === 'AggregateError' && Array.isArray(error.errors)) {
            errorMessage = error.message || 'Multiple errors occurred';
            // Extract all individual errors
            for (const err of error.errors) {
                if (err?.message) {
                    errorDetails.push(err.message);
                } else {
                    errorDetails.push(String(err));
                }
            }
        } else if (error instanceof Error) {
            errorMessage = error.message;
            // For syntax errors, capture the stack which contains line info
            if (error.stack) {
                errorDetails.push(error.stack);
            } else {
                errorDetails.push(error.toString());
            }
        } else if (typeof error === 'string') {
            errorMessage = error;
            errorDetails.push(error);
        } else {
            // Try to get string representation
            errorDetails.push(String(error));
        }

        // Return a JSON response for the Python side to parse
        console.log(JSON.stringify({
            serialized_tx: null,
            error: errorMessage,
            details: errorDetails.join('\n'),
            type: error?.name || 'UnknownError',
            // Include raw errors array if it's an AggregateError
            errors: error?.errors?.map((e: any) => ({
                message: e?.message || String(e),
                line: e?.line,
                column: e?.column,
                file: e?.file
            }))
        }));
        process.exit(1);
    }
}

runSkill();
