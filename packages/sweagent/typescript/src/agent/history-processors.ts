import { History, HistoryItem } from '../types';

/**
 * Configuration for history processors
 */

/**
 * Abstract interface for history processors
 */
export interface AbstractHistoryProcessor {
  (history: History): History;
  type?: string;
  process?: (history: History) => History;
}

/**
 * Utility function to get text content
 */
function getContentText(entry: HistoryItem): string {
  if (typeof entry.content === 'string') {
    return entry.content;
  }

  if (Array.isArray(entry.content)) {
    const texts: string[] = [];
    for (const item of entry.content) {
      if (item.type === 'text' && item.text) {
        texts.push(item.text);
      }
    }
    return texts.join('\n');
  }

  return '';
}

/**
 * Add cache control to an entry
 */
function addCacheControlToEntry(entry: HistoryItem): void {
  // Special handling for different content types
  if (typeof entry.content === 'string') {
    entry.content = [{ type: 'text', text: entry.content, cacheControl: { type: 'ephemeral' } }];
  } else if (Array.isArray(entry.content) && entry.content.length > 0) {
    entry.content[0].cacheControl = { type: 'ephemeral' };
  }

  // Workaround for weird bug with tool role
  if (entry.role === 'tool' && Array.isArray(entry.content) && entry.content.length > 0) {
    delete entry.content[0].cacheControl;
    entry.cacheControl = { type: 'ephemeral' };
  }
}

/**
 * Helper to make a class callable as AbstractHistoryProcessor
 */
function makeCallable<T extends { process: (history: History) => History }>(instance: T): AbstractHistoryProcessor {
  const callable = (history: History): History => {
    return instance.process(history);
  };
  Object.assign(callable, instance);
  return callable as AbstractHistoryProcessor;
}

/**
 * Default history processor that returns history unchanged
 */
export class DefaultHistoryProcessor {
  type: 'default' = 'default';

  process(history: History): History {
    return history;
  }
}

/**
 * Elide all but the last n observations
 */
export class LastNObservations {
  type: 'last_n_observations' = 'last_n_observations';
  n: number;

  constructor(config: { n?: number }) {
    this.n = config.n || 5;
  }

  process(history: History): History {
    if (history.length === 0) {
      return history;
    }

    // Find instance template index (usually second entry)
    let instanceTemplateIndex = -1;
    if (
      history.length > 1 &&
      history[1].role === 'user' &&
      history[1].content?.toString().includes('Instance template')
    ) {
      instanceTemplateIndex = 1;
    }

    // Collect all observation indices (excluding instance template)
    const observationIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].messageType === 'observation' && i !== instanceTemplateIndex) {
        observationIndices.push(i);
      }
    }

    // Determine which observations to keep (last N + 1 for instance template allowance)
    const toKeep = new Set<number>();
    if (observationIndices.length > 0) {
      // Keep n+1 observations (the +1 accounts for preserving space for instance template)
      const keepCount = Math.min(this.n + 1, observationIndices.length);
      const startKeeping = observationIndices.length - keepCount;
      for (let i = startKeeping; i < observationIndices.length; i++) {
        toKeep.add(observationIndices[i]);
      }
    }

    // Build result, eliding observations not in toKeep
    const result: History = [];
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];

      if (entry.messageType === 'observation' && i !== instanceTemplateIndex && !toKeep.has(i)) {
        // Elide this observation
        const elided = { ...entry };
        elided.content = 'Old environment output';
        result.push(elided);
      } else {
        result.push(entry);
      }
    }

    return result;
  }
}

/**
 * Tag tool call observations for better formatting
 */
export class TagToolCallObservations {
  type: 'tag_tool_call_observations' = 'tag_tool_call_observations';
  private tags: Set<string>;
  private functionNames: Set<string>;

  constructor(config?: { tags?: Set<string>; functionNames?: Set<string> }) {
    this.tags = config?.tags || new Set();
    this.functionNames = config?.functionNames || new Set();
  }

  process(history: History): History {
    const result: History = [];

    for (const entry of history) {
      if (entry.action && this.shouldTag(entry.action)) {
        // Add tags to entries with matching actions
        const tagged = { ...entry };
        const newTags = Array.from(this.tags);
        if (tagged.tags) {
          // Preserve existing tags and add new ones
          const existingTags = Array.isArray(tagged.tags) ? tagged.tags : [tagged.tags];
          tagged.tags = [...existingTags, ...newTags.filter((t) => !existingTags.includes(t))];
        } else {
          tagged.tags = newTags;
        }
        result.push(tagged);
      } else {
        result.push(entry);
      }
    }

    return result;
  }

  private shouldTag(action: string): boolean {
    for (const funcName of this.functionNames) {
      if (action.startsWith(funcName + ' ')) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Apply closed window processing to history
 */
export class ClosedWindowHistoryProcessor {
  type: 'closed_window' = 'closed_window';
  windowSize: number;

  constructor(config?: { windowSize?: number }) {
    this.windowSize = config?.windowSize || 10;
  }

  process(history: History): History {
    if (history.length <= this.windowSize) {
      return history;
    }

    // Keep first message and last windowSize messages
    const first = history[0];
    const window = history.slice(-this.windowSize);

    // Add ellipsis message
    const ellipsis: HistoryItem = {
      role: 'user',
      content: `[... ${history.length - this.windowSize - 1} messages elided ...]`,
      messageType: 'observation',
    };

    return [first, ellipsis, ...window];
  }
}

/**
 * Process history with cache control for Anthropic models
 */
export class CacheControlHistoryProcessor {
  type: 'cache_control' = 'cache_control';
  cacheLastN: number;

  constructor(config: { cacheLastN?: number }) {
    this.cacheLastN = config.cacheLastN || 5;
  }

  process(history: History): History {
    if (history.length === 0) {
      return history;
    }

    const result = [...history];

    // Add cache control to last N messages
    const startIdx = Math.max(0, result.length - this.cacheLastN);
    for (let i = startIdx; i < result.length; i++) {
      addCacheControlToEntry(result[i]);
    }

    return result;
  }
}

/**
 * Remove content matching regex patterns
 */
export class RemoveRegex {
  type: 'remove_regex' = 'remove_regex';
  patterns: RegExp[];

  constructor(config: { patterns?: string[] }) {
    this.patterns = (config.patterns || []).map((p: string) => new RegExp(p, 'g'));
  }

  process(history: History): History {
    const result: History = [];

    for (const entry of history) {
      const processed = { ...entry };
      let text = getContentText(processed);

      // Apply all regex patterns
      for (const pattern of this.patterns) {
        text = text.replace(pattern, '');
      }

      if (typeof processed.content === 'string') {
        processed.content = text;
      } else if (Array.isArray(processed.content)) {
        // Preserve images if any
        const hasImage = processed.content.some((item) => item.type === 'image_url');
        if (hasImage) {
          processed.content = processed.content.map((item) => (item.type === 'text' ? { ...item, text } : item));
        } else {
          processed.content = [{ type: 'text', text }];
        }
      }

      result.push(processed);
    }

    return result;
  }
}

/**
 * Parse images in history content
 */
export class ImageParsingHistoryProcessor {
  type: 'image_parsing' = 'image_parsing';
  pattern: RegExp;
  allowedMimeTypes: Set<string>;

  constructor(config?: { allowedMimeTypes?: string[] }) {
    // Pattern to match base64 images
    this.pattern = /(!?\[([^\]]*)\])\(data:(image\/[^;]+);base64,([^)]+)\)/g;
    this.allowedMimeTypes = new Set(config?.allowedMimeTypes || ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  }

  process(history: History): History {
    const result: History = [];

    for (const entry of history) {
      if (entry.role === 'user' && typeof entry.content === 'string') {
        const parsed = this.parseImageContent(entry.content);
        result.push({ ...entry, content: parsed });
      } else {
        result.push(entry);
      }
    }

    return result;
  }

  private parseImageContent(content: string): Array<{ type: string; text?: string; image_url?: { url: string } }> {
    const segments: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    let lastEnd = 0;
    let hasImages = false;

    const addText = (text: string) => {
      if (text) {
        if (segments.length > 0 && segments[segments.length - 1].type === 'text') {
          segments[segments.length - 1].text += text;
        } else {
          segments.push({ type: 'text', text });
        }
      }
    };

    let match;
    while ((match = this.pattern.exec(content)) !== null) {
      const [fullMatch, markdownPrefix, , mimeType, base64Data, markdownSuffix] = match;

      addText(content.substring(lastEnd, match.index));

      const normalizedMimeType = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;

      if (this.allowedMimeTypes.has(normalizedMimeType)) {
        addText(markdownPrefix);
        segments.push({
          type: 'image_url',
          image_url: { url: `data:${normalizedMimeType};base64,${base64Data}` },
        });
        addText(markdownSuffix);
        hasImages = true;
      } else {
        addText(fullMatch);
      }

      lastEnd = match.index + fullMatch.length;
    }

    addText(content.substring(lastEnd));

    return hasImages ? segments : [{ type: 'text', text: content }];
  }
}

/**
 * Create a history processor from configuration
 */
export function createHistoryProcessor(config: { type: string; [key: string]: unknown }): AbstractHistoryProcessor {
  let processor: { process: (history: History) => History };

  switch (config.type) {
    case 'default':
      processor = new DefaultHistoryProcessor();
      break;
    case 'last_n_observations':
      processor = new LastNObservations({ n: (config as { n?: number }).n });
      break;
    case 'tag_tool_call_observations':
      processor = new TagToolCallObservations(config as { tags?: Set<string>; functionNames?: Set<string> });
      break;
    case 'closed_window':
      processor = new ClosedWindowHistoryProcessor();
      break;
    case 'cache_control':
      processor = new CacheControlHistoryProcessor({ cacheLastN: (config as { cacheLastN?: number }).cacheLastN });
      break;
    case 'remove_regex':
      processor = new RemoveRegex({ patterns: (config as { patterns?: string[] }).patterns });
      break;
    case 'image_parsing':
      processor = new ImageParsingHistoryProcessor({
        allowedMimeTypes: (config as { allowedMimeTypes?: string[] }).allowedMimeTypes,
      });
      break;
    default:
      throw new Error(`Unknown history processor type: ${config.type}`);
  }

  return makeCallable(processor);
}

/**
 * Chain multiple history processors
 */
export function chainHistoryProcessors(processors: AbstractHistoryProcessor[]): AbstractHistoryProcessor {
  const chained = {
    process(history: History): History {
      let result = history;
      for (const processor of processors) {
        result = processor(result);
      }
      return result;
    },
  };

  return makeCallable(chained);
}
