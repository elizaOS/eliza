/** Defines the validation-aware streaming operations consumed by structured prompt execution. */

export type DynamicPromptStreamExtractor = {
	push(chunk: string): void;
	flush(): void;
	reset(): void;
	signalError(message: string): void;
	signalRetry(retry: number): { validatedFields: string[] };
	diagnose(): {
		missingFields: string[];
		invalidFields: string[];
		incompleteFields: string[];
	};
	getValidatedFields(): Map<string, string>;
};
