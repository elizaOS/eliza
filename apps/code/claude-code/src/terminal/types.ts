/**
 * Terminal Interface Types
 * 
 * Type definitions for the terminal interface module.
 */

/**
 * Terminal theme options
 */
export type TerminalTheme = 'dark' | 'light' | 'system';

/**
 * Terminal configuration
 */
export interface TerminalConfig {
  /**
   * Terminal color theme
   */
  theme: TerminalTheme;
  
  /**
   * Whether to use colors in output
   */
  useColors: boolean;
  
  /**
   * Whether to show progress indicators
   */
  showProgressIndicators: boolean;
  
  /**
   * Whether to enable syntax highlighting for code
   */
  codeHighlighting: boolean;
  
  /**
   * Maximum terminal height (rows)
   */
  maxHeight?: number;
  
  /**
   * Maximum terminal width (columns)
   */
  maxWidth?: number;
}

/**
 * Spinner instance for progress indicators
 */
export interface SpinnerInstance {
  /**
   * Spinner identifier
   */
  id: string;
  
  /**
   * Update spinner text
   */
  update(text: string): SpinnerInstance;
  
  /**
   * Mark spinner as successful and stop
   */
  succeed(text?: string): SpinnerInstance;
  
  /**
   * Mark spinner as failed and stop
   */
  fail(text?: string): SpinnerInstance;
  
  /**
   * Mark spinner with warning and stop
   */
  warn(text?: string): SpinnerInstance;
  
  /**
   * Mark spinner with info and stop
   */
  info(text?: string): SpinnerInstance;
  
  /**
   * Stop spinner without any indicator
   */
  stop(): SpinnerInstance;
}

/**
 * Prompt option types
 */
export type PromptType = 'input' | 'password' | 'confirm' | 'list' | 'rawlist' | 'checkbox' | 'editor';

/**
 * Common prompt option properties
 */
export interface BasePromptOptions {
  /**
   * Prompt type
   */
  type: PromptType;
  
  /**
   * Name of the value in the returned object
   */
  name: string;
  
  /**
   * Message to display to the user
   */
  message: string;
  
  /**
   * Default value
   */
  default?: any;
  
  /**
   * Validation function
   */
  validate?: (input: any) => boolean | string | Promise<boolean | string>;
  
  /**
   * Whether the prompt is required
   */
  required?: boolean;
}

/**
 * Input prompt options
 */
export interface InputPromptOptions extends BasePromptOptions {
  type: 'input';
  filter?: (input: string) => any;
  transformer?: (input: string) => string;
}

/**
 * Password prompt options
 */
export interface PasswordPromptOptions extends BasePromptOptions {
  type: 'password';
  mask?: string;
}

/**
 * Confirmation prompt options
 */
export interface ConfirmPromptOptions extends BasePromptOptions {
  type: 'confirm';
}

/**
 * List prompt options
 */
export interface ListPromptOptions extends BasePromptOptions {
  type: 'list' | 'rawlist';
  choices: Array<string | { name: string; value: any; short?: string }>;
  pageSize?: number;
}

/**
 * Checkbox prompt options
 */
export interface CheckboxPromptOptions extends BasePromptOptions {
  type: 'checkbox';
  choices: Array<string | { name: string; value: any; checked?: boolean; disabled?: boolean | string }>;
  pageSize?: number;
}

/**
 * Editor prompt options
 */
export interface EditorPromptOptions extends BasePromptOptions {
  type: 'editor';
  postfix?: string;
}

/**
 * Combined prompt options type
 */
export type PromptOptions = 
  | InputPromptOptions
  | PasswordPromptOptions
  | ConfirmPromptOptions
  | ListPromptOptions
  | CheckboxPromptOptions
  | EditorPromptOptions;

/**
 * Terminal interface for user interaction
 */
export interface TerminalInterface {
  /**
   * Clear the terminal screen
   */
  clear(): void;
  
  /**
   * Display formatted content
   */
  display(content: string): void;
  
  /**
   * Display a welcome message
   */
  displayWelcome(): void;
  
  /**
   * Display a message with emphasis
   */
  emphasize(message: string): void;
  
  /**
   * Display an informational message
   */
  info(message: string): void;
  
  /**
   * Display a success message
   */
  success(message: string): void;
  
  /**
   * Display a warning message
   */
  warn(message: string): void;
  
  /**
   * Display an error message
   */
  error(message: string): void;
  
  /**
   * Create a clickable link in the terminal if supported
   */
  link(text: string, url: string): string;
  
  /**
   * Display a table of data
   */
  table(data: any[][], options?: { header?: string[]; border?: boolean }): void;
  
  /**
   * Prompt user for input
   */
  prompt<T>(options: PromptOptions): Promise<T>;
  
  /**
   * Create a spinner for showing progress
   */
  spinner(text: string, id?: string): SpinnerInstance;
} 