import { logger } from '@elizaos/core';
import { AutoTokenizer, type PreTrainedTokenizer } from '@huggingface/transformers';

// Import the MODEL_SPECS type from a new types file we'll create later
import type { ModelSpec } from '../types';

/**
 * Represents a Tokenizer Manager which manages tokenizers for different models.
 * * @class TokenizerManager
 */
export class TokenizerManager {
  private static instance: TokenizerManager | null = null;
  private tokenizers: Map<string, PreTrainedTokenizer>;
  private cacheDir: string;
  private modelsDir: string;

  /**
   * Constructor for creating a new instance of the class.
   *
   * @param {string} cacheDir - The directory for caching data.
   * @param {string} modelsDir - The directory for storing models.
   */
  private constructor(cacheDir: string, modelsDir: string) {
    this.tokenizers = new Map();
    this.cacheDir = cacheDir;
    this.modelsDir = modelsDir;
  }

  /**
   * Get the singleton instance of TokenizerManager class. If the instance does not exist, it will create a new one.
   *
   * @param {string} cacheDir - The directory to cache the tokenizer models.
   * @param {string} modelsDir - The directory where tokenizer models are stored.
   * @returns {TokenizerManager} The singleton instance of TokenizerManager.
   */
  static getInstance(cacheDir: string, modelsDir: string): TokenizerManager {
    if (!TokenizerManager.instance) {
      TokenizerManager.instance = new TokenizerManager(cacheDir, modelsDir);
    }
    return TokenizerManager.instance;
  }

  /**
   * Asynchronously loads a tokenizer based on the provided ModelSpec configuration.
   *
   * @param {ModelSpec} modelConfig - The configuration object for the model to load the tokenizer for.
   * @returns {Promise<PreTrainedTokenizer>} - A promise that resolves to the loaded tokenizer.
   */
  async loadTokenizer(modelConfig: ModelSpec): Promise<PreTrainedTokenizer> {
    try {
      const tokenizerKey = `${modelConfig.tokenizer.type}-${modelConfig.tokenizer.name}`;
      logger.info('Loading tokenizer:', {
        key: tokenizerKey,
        name: modelConfig.tokenizer.name,
        type: modelConfig.tokenizer.type,
        modelsDir: this.modelsDir,
        cacheDir: this.cacheDir,
      });

      if (this.tokenizers.has(tokenizerKey)) {
        logger.info('Using cached tokenizer:', { key: tokenizerKey });
        const cachedTokenizer = this.tokenizers.get(tokenizerKey);
        if (!cachedTokenizer) {
          throw new Error(`Tokenizer ${tokenizerKey} exists in map but returned undefined`);
        }
        return cachedTokenizer;
      }

      // Check if models directory exists
      const fs = await import('node:fs');
      if (!fs.existsSync(this.modelsDir)) {
        logger.warn('Models directory does not exist, creating it:', this.modelsDir);
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }

      logger.info(
        'Initializing new tokenizer from HuggingFace with models directory:',
        this.modelsDir
      );

      try {
        const tokenizer = await AutoTokenizer.from_pretrained(modelConfig.tokenizer.name, {
          cache_dir: this.modelsDir,
          local_files_only: false,
        });

        this.tokenizers.set(tokenizerKey, tokenizer);
        logger.success('Tokenizer loaded successfully:', { key: tokenizerKey });
        return tokenizer;
      } catch (tokenizeError) {
        logger.error('Failed to load tokenizer from HuggingFace:', {
          error: tokenizeError instanceof Error ? tokenizeError.message : String(tokenizeError),
          stack: tokenizeError instanceof Error ? tokenizeError.stack : undefined,
          tokenizer: modelConfig.tokenizer.name,
          modelsDir: this.modelsDir,
        });

        // Try again with local_files_only set to false and a longer timeout
        logger.info('Retrying tokenizer loading...');
        const tokenizer = await AutoTokenizer.from_pretrained(modelConfig.tokenizer.name, {
          cache_dir: this.modelsDir,
          local_files_only: false,
        });

        this.tokenizers.set(tokenizerKey, tokenizer);
        logger.success('Tokenizer loaded successfully on retry:', {
          key: tokenizerKey,
        });
        return tokenizer;
      }
    } catch (error) {
      logger.error('Failed to load tokenizer:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        model: modelConfig.name,
        tokenizer: modelConfig.tokenizer.name,
        modelsDir: this.modelsDir,
      });
      throw error;
    }
  }

  /**
   * Encodes the given text using the specified tokenizer model configuration.
   *
   * @param {string} text - The text to encode.
   * @param {ModelSpec} modelConfig - The configuration for the model tokenizer.
   * @returns {Promise<number[]>} - An array of integers representing the encoded text.
   * @throws {Error} - If the text encoding fails, an error is thrown.
   */
  async encode(text: string, modelConfig: ModelSpec): Promise<number[]> {
    try {
      logger.info('Encoding text with tokenizer:', {
        length: text.length,
        tokenizer: modelConfig.tokenizer.name,
      });

      const tokenizer = await this.loadTokenizer(modelConfig);

      logger.info('Tokenizer loaded, encoding text...');
      const encoded = await tokenizer.encode(text, {
        add_special_tokens: true,
        return_token_type_ids: false,
      });

      logger.info('Text encoded successfully:', {
        tokenCount: encoded.length,
        tokenizer: modelConfig.tokenizer.name,
      });
      return encoded;
    } catch (error) {
      logger.error('Text encoding failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        textLength: text.length,
        tokenizer: modelConfig.tokenizer.name,
        modelsDir: this.modelsDir,
      });
      throw error;
    }
  }

  /**
   * Asynchronously decodes an array of tokens using a tokenizer based on the provided ModelSpec.
   *
   * @param {number[]} tokens - The array of tokens to be decoded.
   * @param {ModelSpec} modelConfig - The ModelSpec object containing information about the model and tokenizer to be used.
   * @returns {Promise<string>} - A Promise that resolves with the decoded text.
   * @throws {Error} - If an error occurs during token decoding.
   */
  async decode(tokens: number[], modelConfig: ModelSpec): Promise<string> {
    try {
      logger.info('Decoding tokens with tokenizer:', {
        count: tokens.length,
        tokenizer: modelConfig.tokenizer.name,
      });

      const tokenizer = await this.loadTokenizer(modelConfig);

      logger.info('Tokenizer loaded, decoding tokens...');
      const decoded = await tokenizer.decode(tokens, {
        skip_special_tokens: true,
        clean_up_tokenization_spaces: true,
      });

      logger.info('Tokens decoded successfully:', {
        textLength: decoded.length,
        tokenizer: modelConfig.tokenizer.name,
      });
      return decoded;
    } catch (error) {
      logger.error('Token decoding failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        tokenCount: tokens.length,
        tokenizer: modelConfig.tokenizer.name,
        modelsDir: this.modelsDir,
      });
      throw error;
    }
  }
}
