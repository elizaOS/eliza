import { reflectionEvaluator } from './reflection';
import { relationshipExtractionEvaluator } from './relationshipExtraction';

export * from './reflection';
export * from './relationshipExtraction';

export const evaluators = [reflectionEvaluator, relationshipExtractionEvaluator];
