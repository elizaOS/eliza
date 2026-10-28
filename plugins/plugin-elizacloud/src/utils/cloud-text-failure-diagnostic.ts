/** Bounded failure metadata only. Never log provider messages, prompts, tools or credentials. */
const record = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
const fields = [
	"model",
	"messages",
	"max_tokens",
	"max_completion_tokens",
	"max_output_tokens",
	"temperature",
	"reasoning_effort",
	"response_format",
	"tools",
	"tool_choice",
	"provider_options",
	"providerOptions",
	"prompt_cache_key",
	"promptCacheKey",
	"stream",
] as const;
const machine = (v: unknown) =>
	typeof v === "string" &&
	/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(v) &&
	!/^(?:sk|eliza|bearer|secret|token)[_.-]/i.test(v)
		? v
		: undefined;
const parameter = (v: unknown) =>
	typeof v === "string" &&
	fields.some(
		(f) =>
			v === f ||
			new RegExp(
				"^" +
					f +
					"(?:\\.[0-9]+)?(?:\\.(?:role|content|type|function|name|parameters|strict))?$",
			).test(v),
	)
		? v
		: undefined;
export function readCloudTextFailureDiagnostic(
	response: Response,
	body: unknown,
	request: Record<string, unknown> = {},
) {
	const top = record(body),
		error = record(top.error),
		message =
			typeof error.message === "string"
				? error.message
				: typeof top.error === "string"
					? top.error
					: "";
	const trace = response.headers.get("x-eliza-trace-id");
	const model =
		typeof request.model === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.model) &&
		!/^(?:sk|eliza|bearer|secret|token)[_.-]/i.test(request.model)
			? request.model
			: undefined;
	const finite = (v: unknown) =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;
	return {
		status: response.status,
		errorShape:
			typeof top.error === "string"
				? "string"
				: top.error && typeof top.error === "object"
					? "object"
					: "absent",
		code: machine(error.code ?? top.code),
		type: machine(error.type ?? top.type),
		param: parameter(error.param ?? top.param),
		validationIssues: (Array.isArray(record(error.details).issues)
			? (record(error.details).issues as unknown[])
			: Array.isArray(record(top.details).issues)
				? (record(top.details).issues as unknown[])
				: []
		)
			.slice(0, 16)
			.map((v) => {
				const issue = record(v);
				const path = Array.isArray(issue.path)
					? issue.path
							.filter((x) => typeof x === "string" || typeof x === "number")
							.join(".")
					: undefined;
				return { code: machine(issue.code), path: parameter(path) };
			}),
		messageFields: fields.filter((f) =>
			new RegExp("\\b" + f + "\\b", "i").test(message),
		),
		traceId:
			trace &&
			/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
				trace,
			)
				? trace
				: undefined,
		controls: {
			model,
			fields: fields.filter((f) => Object.hasOwn(request, f)),
			outputBudget: finite(request.max_tokens),
			completionBudget: finite(request.max_completion_tokens),
			responseBudget: finite(request.max_output_tokens),
			temperature: finite(request.temperature),
			reasoningEffort:
				typeof request.reasoning_effort === "string" &&
				["none", "minimal", "low", "medium", "high", "xhigh"].includes(
					request.reasoning_effort,
				)
					? request.reasoning_effort
					: undefined,
			toolCount: Array.isArray(request.tools)
				? Math.min(request.tools.length, 10000)
				: undefined,
			toolChoice:
				typeof request.tool_choice === "string" &&
				["auto", "none", "required"].includes(request.tool_choice)
					? request.tool_choice
					: request.tool_choice && typeof request.tool_choice === "object"
						? "object"
						: undefined,
			responseFormat:
				typeof record(request.response_format).type === "string" &&
				["text", "json_schema", "json_object"].includes(
					record(request.response_format).type as string,
				)
					? record(request.response_format).type
					: undefined,
			stream: typeof request.stream === "boolean" ? request.stream : undefined,
		},
	};
}
