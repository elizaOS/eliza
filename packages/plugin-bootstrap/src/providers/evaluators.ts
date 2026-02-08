import type {
  ActionExample,
  Evaluator,
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from '@elizaos/core';
import { addHeader, logger } from '@elizaos/core';
import { names, uniqueNamesGenerator } from 'unique-names-generator';

/**
 * Formats the names of evaluators into a comma-separated list, each enclosed in single quotes.
 * @param evaluators - An array of evaluator objects.
 * @returns A string that concatenates the names of all evaluators, each enclosed in single quotes and separated by commas.
 */
/**
 * Formats the names of the evaluators in the provided array.
 *
 * @param {Evaluator[]} evaluators - Array of evaluators.
 * @returns {string} - Formatted string of evaluator names.
 */
export function formatEvaluatorNames(evaluators: Evaluator[]) {
  return evaluators.map((evaluator: Evaluator) => `'${evaluator.name}'`).join(',\n');
}

/**
 * Formats evaluator examples into a readable string, replacing placeholders with generated names.
 * @param evaluators - An array of evaluator objects, each containing examples to format.
 * @returns A string that presents each evaluator example in a structured format, including context, messages, and outcomes, with placeholders replaced by generated names.
 */
export function formatEvaluatorExamples(evaluators: Evaluator[]) {
  return evaluators
    .map((evaluator) => {
      // Filter out examples that are missing required fields
      const validExamples = (evaluator.examples || []).filter(
        (example) => {
          if (!example) {
            logger.error(
              { evaluator: evaluator.name },
              'Evaluator has null/undefined example - check evaluator implementation'
            );
            return false;
          }
          if (!example.prompt) {
            logger.error(
              { evaluator: evaluator.name },
              'Evaluator example missing required "prompt" field - check evaluator implementation'
            );
            return false;
          }
          if (!example.messages) {
            logger.error(
              { evaluator: evaluator.name },
              'Evaluator example missing required "messages" field - check evaluator implementation'
            );
            return false;
          }
          return true;
        }
      );

      return validExamples
        .map((example) => {
          const exampleNames = Array.from({ length: 5 }, () =>
            uniqueNamesGenerator({ dictionaries: [names] })
          );

          let formattedPrompt = example.prompt;
          // Handle missing outcome gracefully (some plugins may not provide it)
          let formattedOutcome = example.outcome || '';

          exampleNames.forEach((name, index) => {
            const placeholder = `{{name${index + 1}}}`;
            formattedPrompt = formattedPrompt.replaceAll(placeholder, name);
            if (formattedOutcome) {
              formattedOutcome = formattedOutcome.replaceAll(placeholder, name);
            }
          });

          const formattedMessages = (example.messages || [])
            .map((message: ActionExample) => {
              if (!message?.name || !message?.content?.text) {
                logger.error(
                  { evaluator: evaluator.name },
                  'Evaluator example message missing "name" or "content.text" - check evaluator implementation'
                );
                return null;
              }
              let messageString = `${message.name}: ${message.content.text}`;
              exampleNames.forEach((name, index) => {
                const placeholder = `{{name${index + 1}}}`;
                messageString = messageString.replaceAll(placeholder, name);
              });
              return (
                messageString +
                (message.content.action || message.content.actions
                  ? ` (${message.content.action || message.content.actions?.join(', ')})`
                  : '')
              );
            })
            .filter(Boolean)
            .join('\n');

          const outcomeSection = formattedOutcome ? `\n\nOutcome:\n${formattedOutcome}` : '';
          return `Prompt:\n${formattedPrompt}\n\nMessages:\n${formattedMessages}${outcomeSection}`;
        })
        .join('\n\n');
    })
    .join('\n\n');
}

/**
 * Formats evaluator details into a string, including both the name and description of each evaluator.
 * @param evaluators - An array of evaluator objects.
 * @returns A string that concatenates the name and description of each evaluator, separated by a colon and a newline character.
 */
export function formatEvaluators(evaluators: Evaluator[]) {
  return evaluators
    .map((evaluator: Evaluator) => `'${evaluator.name}: ${evaluator.description}'`)
    .join(',\n');
}

export const evaluatorsProvider: Provider = {
  name: 'EVALUATORS',
  description: 'Evaluators that can be used to evaluate the conversation after responding',
  private: true,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get evaluators that validate for this message (all validations run in parallel)
    const evaluatorPromises = runtime.evaluators.map(async (evaluator: Evaluator) => {
      try {
        const result = await evaluator.validate(runtime, message, state);
        if (result) {
          return evaluator;
        }
      } catch (e) {
        // Silently skip evaluators that fail validation
      }
      return null;
    });

    // Wait for all validations
    const resolvedEvaluators = await Promise.all(evaluatorPromises);

    // Filter out null values with type-safe filter
    const evaluatorsData = resolvedEvaluators.filter((e): e is Evaluator => e !== null);

    // Early return for no valid evaluators (optimization: avoids unnecessary formatting)
    if (evaluatorsData.length === 0) {
      return {
        values: {
          evaluatorsData: [],
          evaluators: '',
          evaluatorNames: '',
          evaluatorExamples: '',
        },
        text: '',
      };
    }

    // Format evaluator-related texts
    const evaluators =
      evaluatorsData.length > 0
        ? addHeader('# Available Evaluators', formatEvaluators(evaluatorsData))
        : '';

    const evaluatorNames = evaluatorsData.length > 0 ? formatEvaluatorNames(evaluatorsData) : '';

    const evaluatorExamples =
      evaluatorsData.length > 0
        ? addHeader('# Evaluator Examples', formatEvaluatorExamples(evaluatorsData))
        : '';

    const values = {
      evaluatorsData,
      evaluators,
      evaluatorNames,
      evaluatorExamples,
    };

    // Combine all text sections
    const text = [evaluators, evaluatorExamples].filter(Boolean).join('\n\n');

    return {
      values,
      text,
    };
  },
};
