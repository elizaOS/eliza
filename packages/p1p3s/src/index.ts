import * as LoggerProxy from './logger-proxy.js';
import * as NodeHelpers from './node-helpers.js';
import * as ObservableObject from './observable-object.js';

export * from './common/index.js';
export * from './constants.js';
export * from './cron.js';
export * from './data-table.types.js';
export * from './deferred-promise.js';
export * from './errors/index.js';
export * from './evaluation-helpers.js';
export * from './execution-context.js';
export * from './execution-context-establishment-hooks.js';
export * from './execution-status.js';
export * from './expression.js';
export * from './expressions/expression-helpers.js';
export * as ExpressionParser from './extensions/expression-parser.js';
export type {
	DocMetadata,
	DocMetadataArgument,
	DocMetadataExample,
	Extension,
	NativeDoc,
} from './extensions/index.js';
export { type Alias, type AliasCompletion, ExpressionExtensions } from './extensions/index.js';
export * from './from-ai-parse-utils.js';
export * from './global-state.js';
export {
	buildAdjacencyList,
	type ExtractableErrorResult,
	type ExtractableSubgraphData,
	type IConnectionAdjacencyList as AdjacencyList,
	parseExtractableSubgraphSelection,
} from './graph/graph-utils.js';
export * from './highlighted-data.js';
export * from './interfaces.js';
export * from './message-event-bus.js';
export * from './metadata-utils.js';
export { NativeMethods } from './native-methods/index.js';
export * from './node-helpers.js';
export * from './node-parameters/filter-parameter.js';
export * from './node-parameters/node-parameter-value-type-guard.js';
export * from './node-parameters/parameter-type-validation.js';
export * from './node-parameters/path-utils.js';
export * from './node-reference-parser-utils.js';
export * from './node-validation.js';
export * from './result.js';
export * from './run-execution-data/run-execution-data.js';
export * from './run-execution-data-factory.js';
export * from './schemas.js';
export * from './tool-helpers.js';
export * from './trimmed-task-data.js';
export {
	isBinaryValue,
	isFilterValue,
	isINodeProperties,
	isINodePropertiesList,
	isINodePropertyCollection,
	isINodePropertyCollectionList,
	isINodePropertyOptions,
	isINodePropertyOptionsList,
	isNodeConnectionType,
	isResourceLocatorValue,
	isResourceMapperValue,
} from './type-guards.js';
export * from './type-validation.js';
export {
	assert,
	base64DecodeUTF8,
	dedupe,
	deepCopy,
	fileTypeFromMimeType,
	generateSecureToken,
	getCredentialAllowedDomains,
	isCommunityPackageName,
	isDomainAllowed,
	isObjectEmpty,
	isSafeObjectProperty,
	jsonParse,
	jsonStringify,
	randomInt,
	randomString,
	removeCircularRefs,
	replaceCircularReferences,
	sanitizeFilename,
	sanitizeXmlName,
	setSafeObjectProperty,
	sleep,
	sleepWithAbort,
	updateDisplayOptions,
} from './utils.js';
export * from './versioned-node-type.js';
export * from './workflow.js';
export * from './workflow-checksum.js';
export * from './workflow-data-proxy.js';
export * from './workflow-data-proxy-env-provider.js';
export * from './workflow-diff.js';
export * from './workflow-environments-helper.js';
export { WorkflowExpression } from './workflow-expression.js';
export * from './workflow-structure-validation.js';
export * from './workflow-validation.js';
export { LoggerProxy, NodeHelpers, ObservableObject };

import type { ClientRequest } from 'node:http';

declare module 'http' {
	export interface IncomingMessage {
		contentType?: string;
		encoding: BufferEncoding;
		contentDisposition?: { type: string; filename?: string };
		rawBody: Buffer;
		readRawBody(): Promise<void>;
		_body: boolean;

		// This gets added by the `follow-redirects` package
		responseUrl?: string;

		// This is added to response objects for all outgoing requests
		req?: ClientRequest;
	}
}
