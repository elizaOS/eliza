// @elizaos/workflows
//
// Public type surface consumed by @elizaos/plugin-workflow.
// This package is intentionally types-only — no runtime exports, no helpers.
//
// The five top-level types (INode, INodeCredentialsDetails, INodeProperties,
// INodeTypeDescription, IWorkflowSettings) and their transitive type closure
// are defined inline here so the package has no internal modules to maintain.
//
// Inner types whose shape is not exercised by plugin-workflow are kept as
// opaque `unknown`-shaped aliases. If a downstream consumer needs richer
// shapes, restore them here — do not re-introduce side modules.

// ---------------------------------------------------------------------------
// Primitives + small shared shapes
// ---------------------------------------------------------------------------

export interface IDataObject {
	[key: string]: GenericValue | IDataObject | GenericValue[] | IDataObject[];
}

export type GenericValue = string | object | number | boolean | undefined | null;

export type NodeParameterValue = string | number | boolean | undefined | null;

export type NodeParameterValueType =
	| NodeParameterValue
	| INodeParameters
	| INodeParameterResourceLocator
	| ResourceMapperValue
	| FilterValue
	| AssignmentCollectionValue
	| NodeParameterValue[]
	| INodeParameters[]
	| INodeParameterResourceLocator[]
	| ResourceMapperValue[]
	| FilterValue[];

export interface INodeParameters {
	[key: string]: NodeParameterValueType;
}

export interface INodeParameterResourceLocator {
	__rl: true;
	mode: string;
	value: NodeParameterValue;
	cachedResultName?: string;
	cachedResultUrl?: string;
	__regex?: string;
}

export type ResourceMapperValue = {
	mappingMode: string;
	value: { [key: string]: string | number | boolean | null } | null;
	matchingColumns: string[];
	schema: ResourceMapperField[];
	attemptToConvertTypes?: boolean;
	convertFieldsToString?: boolean;
};

export type ResourceMapperField = {
	id: string;
	displayName: string;
	defaultMatch: boolean;
	canBeUsedToMatch?: boolean;
	required: boolean;
	display: boolean;
	type?: FieldType;
	removed?: boolean;
	options?: INodePropertyOptions[];
	readOnly?: boolean;
};

export type FilterValue = {
	options: FilterOptionsValue;
	conditions: FilterConditionValue[];
	combinator: FilterTypeCombinator;
};

export type FilterOptionsValue = {
	caseSensitive: boolean;
	leftValue: string;
	typeValidation: 'strict' | 'loose';
	version: 1 | 2;
};

export type FilterConditionValue = {
	id: string;
	leftValue: NodeParameterValue | NodeParameterValue[];
	operator: FilterOperatorValue;
	rightValue: NodeParameterValue | NodeParameterValue[];
};

export type FilterOperatorValue = {
	type: FilterOperatorType;
	operation: string;
	rightType?: FilterOperatorType;
	singleValue?: boolean;
};

export type FilterOperatorType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'array'
	| 'object'
	| 'dateTime'
	| 'any';

export type FilterTypeCombinator = 'and' | 'or';

export type AssignmentCollectionValue = {
	assignments: AssignmentValue[];
};

export type AssignmentValue = {
	id: string;
	name: string;
	value: NodeParameterValue;
	type?: string;
};

export type FieldType =
	| 'string'
	| 'string-alphanumeric'
	| 'number'
	| 'boolean'
	| 'dateTime'
	| 'time'
	| 'array'
	| 'object'
	| 'options'
	| 'url'
	| 'jwt'
	| 'form-fields';

// ---------------------------------------------------------------------------
// Node connection types
// ---------------------------------------------------------------------------

export const NodeConnectionTypes = {
	AiAgent: 'ai_agent',
	AiChain: 'ai_chain',
	AiDocument: 'ai_document',
	AiEmbedding: 'ai_embedding',
	AiLanguageModel: 'ai_languageModel',
	AiMemory: 'ai_memory',
	AiOutputParser: 'ai_outputParser',
	AiRetriever: 'ai_retriever',
	AiReranker: 'ai_reranker',
	AiTextSplitter: 'ai_textSplitter',
	AiTool: 'ai_tool',
	AiVectorStore: 'ai_vectorStore',
	Main: 'main',
} as const;

export type NodeConnectionType = (typeof NodeConnectionTypes)[keyof typeof NodeConnectionTypes];

export type AINodeConnectionType = Exclude<NodeConnectionType, typeof NodeConnectionTypes.Main>;

// ---------------------------------------------------------------------------
// Display options + conditions
// ---------------------------------------------------------------------------

export type DisplayCondition =
	| { _cnd: { eq: NodeParameterValue } }
	| { _cnd: { not: NodeParameterValue } }
	| { _cnd: { gte: number | string } }
	| { _cnd: { lte: number | string } }
	| { _cnd: { gt: number | string } }
	| { _cnd: { lt: number | string } }
	| { _cnd: { between: { from: number | string; to: number | string } } }
	| { _cnd: { startsWith: string } }
	| { _cnd: { endsWith: string } }
	| { _cnd: { includes: string } }
	| { _cnd: { regex: string } }
	| { _cnd: { exists: true } };

export interface IDisplayOptions {
	hide?: {
		[key: string]: Array<NodeParameterValue | DisplayCondition> | undefined;
	};
	show?: {
		'@version'?: Array<number | DisplayCondition>;
		'@tool'?: Array<boolean | DisplayCondition>;
		[key: string]: Array<NodeParameterValue | DisplayCondition> | undefined;
	};

	hideOnCloud?: boolean;
}

export type FeatureCondition = boolean | DisplayCondition[];
export type NodeFeaturesDefinition = Record<string, FeatureCondition>;

// ---------------------------------------------------------------------------
// Property type metadata
// ---------------------------------------------------------------------------

export type NodePropertyTypes =
	| 'boolean'
	| 'button'
	| 'collection'
	| 'color'
	| 'dateTime'
	| 'fixedCollection'
	| 'hidden'
	| 'json'
	| 'notice'
	| 'multiOptions'
	| 'number'
	| 'options'
	| 'string'
	| 'credentialsSelect'
	| 'resourceLocator'
	| 'curlImport'
	| 'resourceMapper'
	| 'filter'
	| 'assignmentCollection'
	| 'credentials'
	| 'workflowSelector';

export interface INodePropertyTypeOptions {
	action?: string;
	containerClass?: string;
	alwaysOpenEditWindow?: boolean;
	codeAutocomplete?: string;
	editor?: string;
	editorIsReadOnly?: boolean;
	editorLanguage?: string;
	loadOptionsDependsOn?: string[];
	loadOptionsMethod?: string;
	loadOptions?: unknown;
	maxValue?: number;
	minValue?: number;
	multipleValues?: boolean;
	multipleValueButtonText?: string;
	numberPrecision?: number;
	password?: boolean;
	rows?: number;
	showAlpha?: boolean;
	sortable?: boolean;
	expirable?: boolean;
	resourceMapper?: unknown;
	filter?: unknown;
	assignment?: unknown;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Node properties (one of the 5 keep types)
// ---------------------------------------------------------------------------

export interface INodeProperties {
	displayName: string;
	name: string;
	type: NodePropertyTypes;
	typeOptions?: INodePropertyTypeOptions;
	default: NodeParameterValueType;
	description?: string;
	hint?: string;
	builderHint?: IParameterBuilderHint;
	disabledOptions?: IDisplayOptions;
	displayOptions?: IDisplayOptions;
	envFeatureFlag?: Uppercase<string>;
	options?: Array<INodePropertyOptions | INodeProperties | INodePropertyCollection>;
	placeholder?: string;
	isNodeSetting?: boolean;
	noDataExpression?: boolean;
	required?: boolean;
	routing?: INodePropertyRouting;
	credentialTypes?: Array<
		'extends:oAuth2Api' | 'extends:oAuth1Api' | 'has:authenticate' | 'has:genericAuth'
	>;
	extractValue?: INodePropertyValueExtractor;
	modes?: INodePropertyMode[];
	requiresDataPath?: 'single' | 'multiple';
	doNotInherit?: boolean;
	validateType?: FieldType;
	ignoreValidationDuringExecution?: boolean;
	allowArbitraryValues?: boolean;
	resolvableField?: boolean;
}

export interface IParameterBuilderHint {
	propertyHint: string;
	placeholderSupported?: boolean;
}

export interface INodePropertyOptions {
	name: string;
	value: string | number | boolean;
	action?: string;
	description?: string;
	builderHint?: IParameterBuilderHint;
	routing?: INodePropertyRouting;
	outputConnectionType?: NodeConnectionType;
	inputSchema?: unknown;
	displayOptions?: IDisplayOptions;
	disabledOptions?: undefined;
}

export interface INodePropertyCollection {
	displayName: string;
	name: string;
	values: INodeProperties[];
	builderHint?: IParameterBuilderHint;
}

export interface INodePropertyMode {
	displayName: string;
	name: string;
	type: 'string' | 'list';
	hint?: string;
	validation?: unknown[];
	placeholder?: string;
	url?: string;
	extractValue?: INodePropertyValueExtractor;
	initType?: string;
	entryTypes?: Record<string, unknown>;
	search?: INodePropertyRouting;
	typeOptions?: unknown;
}

export interface INodePropertyValueExtractorRegex {
	type: 'regex';
	regex: string | RegExp;
}

export type INodePropertyValueExtractor = INodePropertyValueExtractorRegex;

export interface INodePropertyRouting {
	operations?: unknown;
	output?: unknown;
	request?: unknown;
	send?: unknown;
}

// ---------------------------------------------------------------------------
// Credentials (one of the 5 keep types)
// ---------------------------------------------------------------------------

export interface INodeCredentialsDetails {
	id: string | null;
	name: string;
	__aiGatewayManaged?: boolean;
}

export interface INodeCredentials {
	[key: string]: INodeCredentialsDetails;
}

export interface INodeCredentialDescription {
	name: string;
	required?: boolean;
	displayOptions?: IDisplayOptions;
	displayName?: string;
	testedBy?: unknown;
}

// ---------------------------------------------------------------------------
// Node (one of the 5 keep types)
// ---------------------------------------------------------------------------

export type OnError = 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow';

export interface INode {
	id: string;
	name: string;
	typeVersion: number;
	type: string;
	position: [number, number];
	disabled?: boolean;
	notes?: string;
	notesInFlow?: boolean;
	retryOnFail?: boolean;
	maxTries?: number;
	waitBetweenTries?: number;
	alwaysOutputData?: boolean;
	executeOnce?: boolean;
	onError?: OnError;
	continueOnFail?: boolean;
	parameters: INodeParameters;
	credentials?: INodeCredentials;
	webhookId?: string;
	extendsCredential?: string;
	rewireOutputLogTo?: NodeConnectionType;
	forceCustomOperation?: {
		resource: string;
		operation: string;
	};
}

// ---------------------------------------------------------------------------
// Node type description (one of the 5 keep types)
// ---------------------------------------------------------------------------

export type Themed<T> = T | { light: T; dark: T };
export type Icon = `fa:${string}` | `file:${string}` | Themed<`file:${string}`>;
export type ThemeIconColor =
	| 'gray'
	| 'black'
	| 'blue'
	| 'light-blue'
	| 'dark-blue'
	| 'orange'
	| 'orange-red'
	| 'pink-red'
	| 'red'
	| 'light-green'
	| 'green'
	| 'dark-green'
	| 'azure'
	| 'purple'
	| 'crimson';

export type NodeGroupType = 'input' | 'output' | 'organization' | 'schedule' | 'transform' | 'trigger';

export type CodexData = {
	categories?: string[];
	subcategories?: { [category: string]: string[] };
	resources?: {
		credentialDocumentation?: { url: string }[];
		primaryDocumentation?: { url: string }[];
	};
	alias?: string[];
};

export interface IRelatedNode {
	nodeType: string;
	relationHint: string;
}

export interface IBuilderHintInputConfig {
	required: boolean;
	displayOptions?: IDisplayOptions;
}
export type BuilderHintInputs = Partial<Record<AINodeConnectionType, IBuilderHintInputConfig>>;

export interface IBuilderHintOutputConfig {
	required?: boolean;
	displayOptions?: IDisplayOptions;
}
export type BuilderHintOutputs = Partial<Record<NodeConnectionType, IBuilderHintOutputConfig>>;

export interface IBuilderHint {
	inputs?: BuilderHintInputs;
	outputs?: BuilderHintOutputs;
	searchHint?: string;
	relatedNodes?: IRelatedNode[];
}

export type UsableAsToolDescription = {
	replacements?: Partial<Omit<INodeTypeBaseDescription, 'usableAsTool'>>;
};

export interface INodeTypeBaseDescription {
	displayName: string;
	name: string;
	icon?: Icon;
	iconColor?: ThemeIconColor;
	iconUrl?: Themed<string>;
	iconBasePath?: string;
	badgeIconUrl?: Themed<string>;
	group: NodeGroupType[];
	description: string;
	documentationUrl?: string;
	subtitle?: string;
	defaultVersion?: number;
	codex?: CodexData;
	parameterPane?: 'wide';
	hidden?: true;
	usableAsTool?: true | UsableAsToolDescription;
	builderHint?: IBuilderHint;
	schemaPath?: string;
}

export type NodeDefaults = Partial<{
	color: string;
	name: string;
}>;

export interface INodeInputConfiguration {
	category?: string;
	displayName?: string;
	required?: boolean;
	type: NodeConnectionType;
	filter?: { nodes?: string[]; excludedNodes?: string[] };
	maxConnections?: number;
}

export interface INodeOutputConfiguration {
	category?: 'error';
	displayName?: string;
	maxConnections?: number;
	required?: boolean;
	type: NodeConnectionType;
	filter?: { nodes?: string[]; excludedNodes?: string[] };
}

export type ExpressionString = `={{${string}}}`;

export interface INodeHookDescription {
	method: string;
}

export type WebhookType = 'default' | 'setup';

export type WebhookResponseMode =
	| 'onReceived'
	| 'lastNode'
	| 'responseNode'
	| 'formPage'
	| 'hostedChat'
	| 'streaming';

export type WebhookResponseData = 'allEntries' | 'firstEntryJson' | 'firstEntryBinary' | 'noData';

export type IHttpRequestMethods =
	| 'DELETE'
	| 'GET'
	| 'HEAD'
	| 'OPTIONS'
	| 'PATCH'
	| 'POST'
	| 'PUT';

export interface IWebhookDescription {
	[key: string]: IHttpRequestMethods | WebhookResponseMode | boolean | string | undefined;
	httpMethod: IHttpRequestMethods | string;
	isFullPath?: boolean;
	name: WebhookType;
	path: string;
	responseBinaryPropertyName?: string;
	responseContentType?: string;
	responsePropertyName?: string;
	responseMode?: WebhookResponseMode | string;
	responseData?: WebhookResponseData | string;
	restartWebhook?: boolean;
	nodeType?: 'webhook' | 'form' | 'mcp';
	ndvHideUrl?: string | boolean;
	ndvHideMethod?: string | boolean;
}

export type TriggerPanelDefinition = {
	hideContent?: boolean | string;
	header?: string;
	executionsHelp?: string | { active: string; inactive: string };
	activationHint?: string | { active: string; inactive: string };
};

export type NodeHint = {
	message: string;
	type?: 'info' | 'warning' | 'danger';
	location?: 'outputPane' | 'inputPane' | 'ndv';
	displayCondition?: string;
	whenToDisplay?: 'always' | 'beforeExecution' | 'afterExecution';
};

export interface INodeTypeDescription extends INodeTypeBaseDescription {
	version: number | number[];
	defaults: NodeDefaults;
	eventTriggerDescription?: string;
	activationMessage?: string;
	inputs: Array<NodeConnectionType | INodeInputConfiguration> | ExpressionString;
	requiredInputs?: string | number[] | number;
	inputNames?: string[];
	outputs: Array<NodeConnectionType | INodeOutputConfiguration> | ExpressionString;
	outputNames?: string[];
	properties: INodeProperties[];
	credentials?: INodeCredentialDescription[];
	maxNodes?: number;
	polling?: true | undefined;
	supportsCORS?: true | undefined;
	requestDefaults?: unknown;
	requestOperations?: unknown;
	hooks?: {
		[key: string]: INodeHookDescription[] | undefined;
		activate?: INodeHookDescription[];
		deactivate?: INodeHookDescription[];
	};
	webhooks?: IWebhookDescription[];
	translation?: { [key: string]: object };
	mockManualExecution?: true;
	triggerPanel?: TriggerPanelDefinition | boolean;
	extendsCredential?: string;
	hints?: NodeHint[];
	communityNodePackageVersion?: string;
	waitingNodeTooltip?: string;
	__loadOptionsMethods?: string[];
	skipNameGeneration?: boolean;
	features?: NodeFeaturesDefinition;
	builderHint?: IBuilderHint;
	sensitiveOutputFields?: string[];
}

// ---------------------------------------------------------------------------
// Workflow settings (one of the 5 keep types)
// ---------------------------------------------------------------------------

export namespace WorkflowSettings {
	export type CallerPolicy = 'any' | 'none' | 'workflowsFromAList' | 'workflowsFromSameOwner';
	export type SaveDataExecution = 'DEFAULT' | 'all' | 'none';
	export type RedactionPolicy = 'none' | 'mask';
}

export type WorkflowSettingsBinaryMode = 'separate' | 'combined';

export interface IWorkflowSettings {
	timezone?: 'DEFAULT' | string;
	errorWorkflow?: 'DEFAULT' | string;
	callerIds?: string;
	callerPolicy?: WorkflowSettings.CallerPolicy;
	saveDataErrorExecution?: WorkflowSettings.SaveDataExecution;
	saveDataSuccessExecution?: WorkflowSettings.SaveDataExecution;
	saveManualExecutions?: 'DEFAULT' | boolean;
	saveExecutionProgress?: 'DEFAULT' | boolean;
	executionTimeout?: number;
	executionOrder?: 'v0' | 'v1';
	binaryMode?: WorkflowSettingsBinaryMode;
	timeSavedPerExecution?: number;
	timeSavedMode?: 'fixed' | 'dynamic';
	availableInMCP?: boolean;
	credentialResolverId?: string;
	redactionPolicy?: WorkflowSettings.RedactionPolicy;
}
