/**
 * @module builder
 * @description Fluent builder API for defining forms and controls
 *
 * ## Why a Builder API
 *
 * Form definitions can be verbose with many optional fields. The builder
 * API provides:
 *
 * 1. **Type Safety**: Method chaining with TypeScript gives autocomplete
 * 2. **Readability**: Intent is clear from method names
 * 3. **Defaults**: Builder applies sensible defaults
 * 4. **Validation**: Build-time checks for common mistakes
 *
 * ## Usage Examples
 *
 * ### Simple Form
 *
 * ```typescript
 * const form = Form.create('contact')
 *   .name('Contact Form')
 *   .control(C.email('email').required())
 *   .control(C.text('message').required())
 *   .build();
 * ```
 *
 * ### Complex Form
 *
 * ```typescript
 * const registrationForm = Form.create('registration')
 *   .name('User Registration')
 *   .description('Create your account')
 *   .control(
 *     C.email('email')
 *       .required()
 *       .ask('What email should we use for your account?')
 *       .example('user@example.com')
 *   )
 *   .control(
 *     C.text('username')
 *       .required()
 *       .minLength(3)
 *       .maxLength(20)
 *       .pattern('^[a-z0-9_]+$')
 *       .ask('Choose a username (letters, numbers, underscore)')
 *   )
 *   .control(
 *     C.number('age')
 *       .min(13)
 *       .ask('How old are you?')
 *   )
 *   .onSubmit('handle_registration')
 *   .ttl({ minDays: 7, maxDays: 30 })
 *   .build();
 * ```
 *
 * ### Custom Type
 *
 * ```typescript
 * // Register custom type first
 * FormService.registerType('solana_address', {
 *   validate: (v) => ({
 *     valid: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(v)),
 *     error: 'Invalid Solana address'
 *   }),
 *   extractionPrompt: 'a Solana wallet address (Base58 encoded)'
 * });
 *
 * // Use in form
 * const form = Form.create('wallet')
 *   .control(
 *     C.field('walletAddress')
 *       .type('solana_address')
 *       .required()
 *       .label('Wallet Address')
 *       .ask('What is your Solana wallet address?')
 *   )
 *   .build();
 * ```
 *
 * ## Shorthand Exports
 *
 * For convenience:
 * - `Form` is an alias for `FormBuilder`
 * - `C` is an alias for `ControlBuilder`
 *
 * This enables the concise syntax shown in examples.
 */

import type { JsonValue } from "@elizaos/core";
import type {
  FormControl,
  FormControlOption,
  FormControlDependency,
  FormDefinition,
  FormDefinitionHooks,
} from "./types";

// ============================================================================
// CONTROL BUILDER
// ============================================================================

/**
 * Fluent builder for FormControl.
 *
 * Create controls with readable, chainable syntax:
 *
 * ```typescript
 * ControlBuilder.email('email').required().ask('What is your email?')
 * ```
 *
 * All methods return `this` for chaining except `build()` which returns
 * the final FormControl.
 */
export class ControlBuilder {
  /** Partial control being built */
  private control: Partial<FormControl>;

  /**
   * Create a new ControlBuilder.
   *
   * @param key - The unique key for this control
   */
  constructor(key: string) {
    this.control = { key };
  }

  // ═══ STATIC FACTORIES ═══
  // WHY static factories: Cleaner than `new ControlBuilder(key).type('text')`

  /** Create a generic field builder */
  static field(key: string): ControlBuilder {
    return new ControlBuilder(key);
  }

  /** Create a text field */
  static text(key: string): ControlBuilder {
    return new ControlBuilder(key).type("text");
  }

  /** Create an email field */
  static email(key: string): ControlBuilder {
    return new ControlBuilder(key).type("email");
  }

  /** Create a number field */
  static number(key: string): ControlBuilder {
    return new ControlBuilder(key).type("number");
  }

  /** Create a boolean (yes/no) field */
  static boolean(key: string): ControlBuilder {
    return new ControlBuilder(key).type("boolean");
  }

  /** Create a select field with options */
  static select(key: string, options: FormControlOption[]): ControlBuilder {
    return new ControlBuilder(key).type("select").options(options);
  }

  /** Create a date field */
  static date(key: string): ControlBuilder {
    return new ControlBuilder(key).type("date");
  }

  /** Create a file upload field */
  static file(key: string): ControlBuilder {
    return new ControlBuilder(key).type("file");
  }

  // ═══ TYPE ═══

  /** Set the field type */
  type(type: string): this {
    this.control.type = type;
    return this;
  }

  // ═══ BEHAVIOR ═══

  /** Mark field as required */
  required(): this {
    this.control.required = true;
    return this;
  }

  /** Mark field as optional (default) */
  optional(): this {
    this.control.required = false;
    return this;
  }

  /** Mark field as hidden (extract silently, never ask) */
  hidden(): this {
    this.control.hidden = true;
    return this;
  }

  /** Mark field as sensitive (don't echo value back) */
  sensitive(): this {
    this.control.sensitive = true;
    return this;
  }

  /** Mark field as readonly (can't change after set) */
  readonly(): this {
    this.control.readonly = true;
    return this;
  }

  /** Mark field as accepting multiple values */
  multiple(): this {
    this.control.multiple = true;
    return this;
  }

  // ═══ VALIDATION ═══

  /** Set regex pattern for validation */
  pattern(regex: string): this {
    this.control.pattern = regex;
    return this;
  }

  /** Set minimum value (for numbers) or minimum length (via minLength) */
  min(n: number): this {
    this.control.min = n;
    return this;
  }

  /** Set maximum value (for numbers) or maximum length (via maxLength) */
  max(n: number): this {
    this.control.max = n;
    return this;
  }

  /** Set minimum string length */
  minLength(n: number): this {
    this.control.minLength = n;
    return this;
  }

  /** Set maximum string length */
  maxLength(n: number): this {
    this.control.maxLength = n;
    return this;
  }

  /** Set allowed values (enum) */
  enum(values: string[]): this {
    this.control.enum = values;
    return this;
  }

  /** Set select options */
  options(opts: FormControlOption[]): this {
    this.control.options = opts;
    return this;
  }

  // ═══ AGENT HINTS ═══
  // WHY agent hints: Help LLM extract values correctly

  /** Set human-readable label */
  label(label: string): this {
    this.control.label = label;
    return this;
  }

  /** Set custom prompt for asking this field */
  ask(prompt: string): this {
    this.control.askPrompt = prompt;
    return this;
  }

  /** Set description for LLM context */
  description(desc: string): this {
    this.control.description = desc;
    return this;
  }

  /** Add extraction hints (keywords to look for) */
  hint(...hints: string[]): this {
    this.control.extractHints = hints;
    return this;
  }

  /** Set example value for "give me an example" */
  example(value: string): this {
    this.control.example = value;
    return this;
  }

  /** Set confidence threshold for auto-acceptance */
  confirmThreshold(n: number): this {
    this.control.confirmThreshold = n;
    return this;
  }

  // ═══ FILE OPTIONS ═══

  /** Set accepted MIME types for file upload */
  accept(mimeTypes: string[]): this {
    this.control.file = { ...this.control.file, accept: mimeTypes };
    return this;
  }

  /** Set maximum file size in bytes */
  maxSize(bytes: number): this {
    this.control.file = { ...this.control.file, maxSize: bytes };
    return this;
  }

  /** Set maximum number of files */
  maxFiles(n: number): this {
    this.control.file = { ...this.control.file, maxFiles: n };
    return this;
  }

  // ═══ ACCESS ═══

  /** Set roles that can see/fill this field */
  roles(...roles: string[]): this {
    this.control.roles = roles;
    return this;
  }

  // ═══ DEFAULTS & CONDITIONS ═══

  /** Set default value */
  default(value: JsonValue): this {
    this.control.defaultValue = value;
    return this;
  }

  /** Set dependency on another field */
  dependsOn(
    field: string,
    condition: FormControlDependency["condition"] = "exists",
    value?: JsonValue,
  ): this {
    this.control.dependsOn = { field, condition, value };
    return this;
  }

  // ═══ DATABASE ═══

  /** Set database column name (defaults to key) */
  dbbind(columnName: string): this {
    this.control.dbbind = columnName;
    return this;
  }

  // ═══ UI ═══

  /** Set section name for grouping */
  section(name: string): this {
    this.control.ui = { ...this.control.ui, section: name };
    return this;
  }

  /** Set display order within section */
  order(n: number): this {
    this.control.ui = { ...this.control.ui, order: n };
    return this;
  }

  /** Set placeholder text */
  placeholder(text: string): this {
    this.control.ui = { ...this.control.ui, placeholder: text };
    return this;
  }

  /** Set help text */
  helpText(text: string): this {
    this.control.ui = { ...this.control.ui, helpText: text };
    return this;
  }

  /** Set custom widget type */
  widget(type: string): this {
    this.control.ui = { ...this.control.ui, widget: type };
    return this;
  }

  // ═══ I18N ═══

  /** Add localized text for a locale */
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

  /** Add custom metadata */
  meta(key: string, value: JsonValue): this {
    this.control.meta = { ...this.control.meta, [key]: value };
    return this;
  }

  // ═══ BUILD ═══

  /**
   * Build the final FormControl.
   *
   * Applies defaults and validates the control.
   *
   * @returns Complete FormControl object
   */
  build(): FormControl {
    // Apply defaults
    const control: FormControl = {
      key: this.control.key!,
      label: this.control.label || prettify(this.control.key!),
      type: this.control.type || "text",
      ...this.control,
    };

    return control;
  }
}

// ============================================================================
// FORM BUILDER
// ============================================================================

/**
 * Fluent builder for FormDefinition.
 *
 * Create forms with readable, chainable syntax:
 *
 * ```typescript
 * Form.create('contact')
 *   .name('Contact Form')
 *   .control(C.email('email').required())
 *   .onSubmit('handle_contact')
 *   .build();
 * ```
 */
export class FormBuilder {
  /** Partial form being built */
  private form: Partial<FormDefinition>;

  /**
   * Create a new FormBuilder.
   *
   * @param id - Unique form identifier
   */
  constructor(id: string) {
    this.form = { id, controls: [] };
  }

  // ═══ STATIC FACTORY ═══

  /** Create a new form builder */
  static create(id: string): FormBuilder {
    return new FormBuilder(id);
  }

  // ═══ METADATA ═══

  /** Set form name */
  name(name: string): this {
    this.form.name = name;
    return this;
  }

  /** Set form description */
  description(desc: string): this {
    this.form.description = desc;
    return this;
  }

  /** Set form version */
  version(v: number): this {
    this.form.version = v;
    return this;
  }

  // ═══ CONTROLS ═══

  /**
   * Add a control to the form.
   *
   * Accepts either a ControlBuilder (calls .build()) or a FormControl.
   */
  control(builder: ControlBuilder | FormControl): this {
    const ctrl = builder instanceof ControlBuilder ? builder.build() : builder;
    this.form.controls!.push(ctrl);
    return this;
  }

  /** Add multiple controls */
  controls(...builders: (ControlBuilder | FormControl)[]): this {
    for (const builder of builders) {
      this.control(builder);
    }
    return this;
  }

  // ═══ SHORTHAND CONTROLS ═══
  // WHY shorthands: Quick form prototyping

  /** Add required text fields */
  required(...keys: string[]): this {
    for (const key of keys) {
      this.control(ControlBuilder.field(key).required());
    }
    return this;
  }

  /** Add optional text fields */
  optional(...keys: string[]): this {
    for (const key of keys) {
      this.control(ControlBuilder.field(key));
    }
    return this;
  }

  // ═══ PERMISSIONS ═══

  /** Set roles that can start this form */
  roles(...roles: string[]): this {
    this.form.roles = roles;
    return this;
  }

  /** Allow multiple submissions per user */
  allowMultiple(): this {
    this.form.allowMultiple = true;
    return this;
  }

  // ═══ UX ═══

  /** Disable undo functionality */
  noUndo(): this {
    this.form.ux = { ...this.form.ux, allowUndo: false };
    return this;
  }

  /** Disable skip functionality */
  noSkip(): this {
    this.form.ux = { ...this.form.ux, allowSkip: false };
    return this;
  }

  /** Disable autofill */
  noAutofill(): this {
    this.form.ux = { ...this.form.ux, allowAutofill: false };
    return this;
  }

  /** Set maximum undo steps */
  maxUndoSteps(n: number): this {
    this.form.ux = { ...this.form.ux, maxUndoSteps: n };
    return this;
  }

  // ═══ TTL ═══

  /** Configure TTL (time-to-live) settings */
  ttl(config: {
    minDays?: number;
    maxDays?: number;
    effortMultiplier?: number;
  }): this {
    this.form.ttl = { ...this.form.ttl, ...config };
    return this;
  }

  // ═══ NUDGE ═══

  /** Disable nudge messages */
  noNudge(): this {
    this.form.nudge = { ...this.form.nudge, enabled: false };
    return this;
  }

  /** Set inactivity hours before nudge */
  nudgeAfter(hours: number): this {
    this.form.nudge = { ...this.form.nudge, afterInactiveHours: hours };
    return this;
  }

  /** Set custom nudge message */
  nudgeMessage(message: string): this {
    this.form.nudge = { ...this.form.nudge, message };
    return this;
  }

  // ═══ HOOKS ═══
  // WHY hooks: Allow consuming plugins to handle form events

  /** Set task worker to call on session start */
  onStart(workerName: string): this {
    this.form.hooks = { ...this.form.hooks, onStart: workerName };
    return this;
  }

  /** Set task worker to call on field change */
  onFieldChange(workerName: string): this {
    this.form.hooks = { ...this.form.hooks, onFieldChange: workerName };
    return this;
  }

  /** Set task worker to call when form is ready to submit */
  onReady(workerName: string): this {
    this.form.hooks = { ...this.form.hooks, onReady: workerName };
    return this;
  }

  /** Set task worker to call on submission */
  onSubmit(workerName: string): this {
    this.form.hooks = { ...this.form.hooks, onSubmit: workerName };
    return this;
  }

  /** Set task worker to call on cancellation */
  onCancel(workerName: string): this {
    this.form.hooks = { ...this.form.hooks, onCancel: workerName };
    return this;
  }

  /** Set task worker to call on expiration */
  onExpire(workerName: string): this {
    this.form.hooks = { ...this.form.hooks, onExpire: workerName };
    return this;
  }

  /** Set multiple hooks at once */
  hooks(hooks: FormDefinitionHooks): this {
    this.form.hooks = { ...this.form.hooks, ...hooks };
    return this;
  }

  // ═══ DEBUG ═══

  /** Enable debug mode (logs extraction reasoning) */
  debug(): this {
    this.form.debug = true;
    return this;
  }

  // ═══ I18N ═══

  /** Add localized form text */
  i18n(
    locale: string,
    translations: { name?: string; description?: string },
  ): this {
    this.form.i18n = { ...this.form.i18n, [locale]: translations };
    return this;
  }

  // ═══ META ═══

  /** Add custom metadata */
  meta(key: string, value: JsonValue): this {
    this.form.meta = { ...this.form.meta, [key]: value };
    return this;
  }

  // ═══ BUILD ═══

  /**
   * Build the final FormDefinition.
   *
   * Applies defaults and validates the form.
   *
   * @returns Complete FormDefinition object
   */
  build(): FormDefinition {
    const form: FormDefinition = {
      id: this.form.id!,
      name: this.form.name || prettify(this.form.id!),
      controls: this.form.controls || [],
      ...this.form,
    };

    return form;
  }
}

// ============================================================================
// SHORTHAND EXPORTS
// ============================================================================

/**
 * Shorthand for FormBuilder.create
 *
 * Usage: `Form.create('myForm')...`
 */
export const Form = FormBuilder;

/**
 * Shorthand for ControlBuilder factories
 *
 * Usage: `C.email('email').required()`
 */
export const C = ControlBuilder;

// ============================================================================
// UTILITY
// ============================================================================

/**
 * Convert snake_case or kebab-case to Title Case.
 *
 * Used to generate human-readable labels from field keys.
 *
 * @example prettify('first_name') // "First Name"
 * @example prettify('email-address') // "Email Address"
 */
function prettify(key: string): string {
  return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
