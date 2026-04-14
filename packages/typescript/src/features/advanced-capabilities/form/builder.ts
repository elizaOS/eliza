/**
 * @module builder
 * @description Fluent builder API for defining forms and controls
 */

import type { JsonValue } from "../../../types/index.ts";
import type {
	FormControl,
	FormControlDependency,
	FormControlOption,
	FormDefinition,
	FormDefinitionHooks,
} from "./types.ts";

// ============================================================================
// CONTROL BUILDER
// ============================================================================

export class ControlBuilder {
	private control: Partial<FormControl>;

	constructor(key: string) {
		this.control = { key };
	}

	// ═══ STATIC FACTORIES ═══

	static field(key: string): ControlBuilder {
		return new ControlBuilder(key);
	}

	static text(key: string): ControlBuilder {
		return new ControlBuilder(key).type("text");
	}

	static email(key: string): ControlBuilder {
		return new ControlBuilder(key).type("email");
	}

	static number(key: string): ControlBuilder {
		return new ControlBuilder(key).type("number");
	}

	static boolean(key: string): ControlBuilder {
		return new ControlBuilder(key).type("boolean");
	}

	static select(key: string, options: FormControlOption[]): ControlBuilder {
		return new ControlBuilder(key).type("select").options(options);
	}

	static date(key: string): ControlBuilder {
		return new ControlBuilder(key).type("date");
	}

	static file(key: string): ControlBuilder {
		return new ControlBuilder(key).type("file");
	}

	// ═══ TYPE ═══

	type(type: string): this {
		this.control.type = type;
		return this;
	}

	// ═══ BEHAVIOR ═══

	required(): this {
		this.control.required = true;
		return this;
	}

	optional(): this {
		this.control.required = false;
		return this;
	}

	hidden(): this {
		this.control.hidden = true;
		return this;
	}

	sensitive(): this {
		this.control.sensitive = true;
		return this;
	}

	readonly(): this {
		this.control.readonly = true;
		return this;
	}

	multiple(): this {
		this.control.multiple = true;
		return this;
	}

	// ═══ VALIDATION ═══

	pattern(regex: string): this {
		this.control.pattern = regex;
		return this;
	}

	min(n: number): this {
		this.control.min = n;
		return this;
	}

	max(n: number): this {
		this.control.max = n;
		return this;
	}

	minLength(n: number): this {
		this.control.minLength = n;
		return this;
	}

	maxLength(n: number): this {
		this.control.maxLength = n;
		return this;
	}

	enum(values: string[]): this {
		this.control.enum = values;
		return this;
	}

	options(opts: FormControlOption[]): this {
		this.control.options = opts;
		return this;
	}

	// ═══ AGENT HINTS ═══

	label(label: string): this {
		this.control.label = label;
		return this;
	}

	ask(prompt: string): this {
		this.control.askPrompt = prompt;
		return this;
	}

	description(desc: string): this {
		this.control.description = desc;
		return this;
	}

	hint(...hints: string[]): this {
		this.control.extractHints = hints;
		return this;
	}

	example(value: string): this {
		this.control.example = value;
		return this;
	}

	confirmThreshold(n: number): this {
		this.control.confirmThreshold = n;
		return this;
	}

	// ═══ FILE OPTIONS ═══

	accept(mimeTypes: string[]): this {
		this.control.file = { ...this.control.file, accept: mimeTypes };
		return this;
	}

	maxSize(bytes: number): this {
		this.control.file = { ...this.control.file, maxSize: bytes };
		return this;
	}

	maxFiles(n: number): this {
		this.control.file = { ...this.control.file, maxFiles: n };
		return this;
	}

	// ═══ ACCESS ═══

	roles(...roles: string[]): this {
		this.control.roles = roles;
		return this;
	}

	// ═══ DEFAULTS & CONDITIONS ═══

	default(value: JsonValue): this {
		this.control.defaultValue = value;
		return this;
	}

	dependsOn(
		field: string,
		condition: FormControlDependency["condition"] = "exists",
		value?: JsonValue,
	): this {
		this.control.dependsOn = { field, condition, value };
		return this;
	}

	// ═══ DATABASE ═══

	dbbind(columnName: string): this {
		this.control.dbbind = columnName;
		return this;
	}

	// ═══ UI ═══

	section(name: string): this {
		this.control.ui = { ...this.control.ui, section: name };
		return this;
	}

	order(n: number): this {
		this.control.ui = { ...this.control.ui, order: n };
		return this;
	}

	placeholder(text: string): this {
		this.control.ui = { ...this.control.ui, placeholder: text };
		return this;
	}

	helpText(text: string): this {
		this.control.ui = { ...this.control.ui, helpText: text };
		return this;
	}

	widget(type: string): this {
		this.control.ui = { ...this.control.ui, widget: type };
		return this;
	}

	// ═══ I18N ═══

	i18n(
		locale: string,
		translations: {
			label?: string;
			description?: string;
			askPrompt?: string;
			helpText?: string;
		},
	): this {
		this.control.i18n = { ...this.control.i18n, [locale]: translations };
		return this;
	}

	// ═══ META ═══

	meta(key: string, value: JsonValue): this {
		this.control.meta = { ...this.control.meta, [key]: value };
		return this;
	}

	// ═══ BUILD ═══

	build(): FormControl {
		const key = this.control.key;
		if (!key) {
			throw new Error("Control key is required");
		}

		const control: FormControl = {
			key,
			label: this.control.label || prettify(key),
			type: this.control.type || "text",
			...this.control,
		};

		return control;
	}
}

// ============================================================================
// FORM BUILDER
// ============================================================================

export class FormBuilder {
	private form: Partial<FormDefinition>;

	constructor(id: string) {
		this.form = { id, controls: [] };
	}

	static create(id: string): FormBuilder {
		return new FormBuilder(id);
	}

	// ═══ METADATA ═══

	name(name: string): this {
		this.form.name = name;
		return this;
	}

	description(desc: string): this {
		this.form.description = desc;
		return this;
	}

	version(v: number): this {
		this.form.version = v;
		return this;
	}

	// ═══ CONTROLS ═══

	control(builder: ControlBuilder | FormControl): this {
		const ctrl = builder instanceof ControlBuilder ? builder.build() : builder;
		this.form.controls?.push(ctrl);
		return this;
	}

	controls(...builders: (ControlBuilder | FormControl)[]): this {
		for (const builder of builders) {
			this.control(builder);
		}
		return this;
	}

	// ═══ SHORTHAND CONTROLS ═══

	required(...keys: string[]): this {
		for (const key of keys) {
			this.control(ControlBuilder.field(key).required());
		}
		return this;
	}

	optional(...keys: string[]): this {
		for (const key of keys) {
			this.control(ControlBuilder.field(key));
		}
		return this;
	}

	// ═══ PERMISSIONS ═══

	roles(...roles: string[]): this {
		this.form.roles = roles;
		return this;
	}

	allowMultiple(): this {
		this.form.allowMultiple = true;
		return this;
	}

	// ═══ UX ═══

	noUndo(): this {
		this.form.ux = { ...this.form.ux, allowUndo: false };
		return this;
	}

	noSkip(): this {
		this.form.ux = { ...this.form.ux, allowSkip: false };
		return this;
	}

	noAutofill(): this {
		this.form.ux = { ...this.form.ux, allowAutofill: false };
		return this;
	}

	maxUndoSteps(n: number): this {
		this.form.ux = { ...this.form.ux, maxUndoSteps: n };
		return this;
	}

	// ═══ TTL ═══

	ttl(config: {
		minDays?: number;
		maxDays?: number;
		effortMultiplier?: number;
	}): this {
		this.form.ttl = { ...this.form.ttl, ...config };
		return this;
	}

	// ═══ NUDGE ═══

	noNudge(): this {
		this.form.nudge = { ...this.form.nudge, enabled: false };
		return this;
	}

	nudgeAfter(hours: number): this {
		this.form.nudge = { ...this.form.nudge, afterInactiveHours: hours };
		return this;
	}

	nudgeMessage(message: string): this {
		this.form.nudge = { ...this.form.nudge, message };
		return this;
	}

	// ═══ HOOKS ═══

	onStart(workerName: string): this {
		this.form.hooks = { ...this.form.hooks, onStart: workerName };
		return this;
	}

	onFieldChange(workerName: string): this {
		this.form.hooks = { ...this.form.hooks, onFieldChange: workerName };
		return this;
	}

	onReady(workerName: string): this {
		this.form.hooks = { ...this.form.hooks, onReady: workerName };
		return this;
	}

	onSubmit(workerName: string): this {
		this.form.hooks = { ...this.form.hooks, onSubmit: workerName };
		return this;
	}

	onCancel(workerName: string): this {
		this.form.hooks = { ...this.form.hooks, onCancel: workerName };
		return this;
	}

	onExpire(workerName: string): this {
		this.form.hooks = { ...this.form.hooks, onExpire: workerName };
		return this;
	}

	hooks(hooks: FormDefinitionHooks): this {
		this.form.hooks = { ...this.form.hooks, ...hooks };
		return this;
	}

	// ═══ DEBUG ═══

	debug(): this {
		this.form.debug = true;
		return this;
	}

	// ═══ I18N ═══

	i18n(
		locale: string,
		translations: { name?: string; description?: string },
	): this {
		this.form.i18n = { ...this.form.i18n, [locale]: translations };
		return this;
	}

	// ═══ META ═══

	meta(key: string, value: JsonValue): this {
		this.form.meta = { ...this.form.meta, [key]: value };
		return this;
	}

	// ═══ BUILD ═══

	build(): FormDefinition {
		const id = this.form.id;
		if (!id) {
			throw new Error("Form id is required");
		}

		const form: FormDefinition = {
			id,
			name: this.form.name || prettify(id),
			controls: this.form.controls || [],
			...this.form,
		};

		return form;
	}
}

// ============================================================================
// SHORTHAND EXPORTS
// ============================================================================

export const Form = FormBuilder;
export const C = ControlBuilder;

// ============================================================================
// UTILITY
// ============================================================================

function prettify(key: string): string {
	return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
