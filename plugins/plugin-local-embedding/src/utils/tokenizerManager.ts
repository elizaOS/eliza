import { logger } from "@elizaos/core";
import type { PreTrainedTokenizer } from "@huggingface/transformers";

// Import the MODEL_SPECS type from a new types file we'll create later
import type { ModelSpec } from "../types";

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
      logger.info(
        {
          key: tokenizerKey,
          name: modelConfig.tokenizer.name,
          type: modelConfig.tokenizer.type,
          modelsDir: this.modelsDir,
          cacheDir: this.cacheDir,
        },
        "Loading tokenizer"
      );

      if (this.tokenizers.has(tokenizerKey)) {
        logger.info({ key: tokenizerKey }, "Using cached tokenizer");
        const cachedTokenizer = this.tokenizers.get(tokenizerKey);
        if (!cachedTokenizer) {
          throw new Error(`Tokenizer ${tokenizerKey} exists in map but returned undefined`);
        }
        return cachedTokenizer;
      }

      // Check if models directory exists
      const fs = await import("node:fs");
      if (!fs.existsSync(this.modelsDir)) {
        logger.warn("Models directory does not exist, creating it:", this.modelsDir);
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }

      logger.info(
        "Initializing new tokenizer from HuggingFace with models directory:",
        this.modelsDir
      );

      const { AutoTokenizer } = await import("@huggingface/transformers");

      try {
        const tokenizer = await AutoTokenizer.from_pretrained(modelConfig.tokenizer.name, {
          cache_dir: this.modelsDir,
          local_files_only: false,
        });

        this.tokenizers.set(tokenizerKey, tokenizer);
        logger.success({ key: tokenizerKey }, "Tokenizer loaded successfully");
        return tokenizer;
      } catch (tokenizeError) {
        logger.error(
          {
            error: tokenizeError instanceof Error ? tokenizeError.message : String(tokenizeError),
            stack: tokenizeError instanceof Error ? tokenizeError.stack : undefined,
            tokenizer: modelConfig.tokenizer.name,
            modelsDir: this.modelsDir,
          },
          "Failed to load tokenizer from HuggingFace"
        );

        // Try again with local_files_only set to false and a longer timeout
        logger.info("Retrying tokenizer loading...");
        const tokenizer = await AutoTokenizer.from_pretrained(modelConfig.tokenizer.name, {
          cache_dir: this.modelsDir,
          local_files_only: false,
        });

        this.tokenizers.set(tokenizerKey, tokenizer);
        logger.success({ key: tokenizerKey }, "Tokenizer loaded successfully on retry");
        return tokenizer;
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          model: modelConfig.name,
          tokenizer: modelConfig.tokenizer.name,
          modelsDir: this.modelsDir,
        },
        "Failed to load tokenizer"
      );
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
      logger.info(
        {
          length: text.length,
          tokenizer: modelConfig.tokenizer.name,
        },
        "Encoding text with tokenizer"
      );

      const tokenizer = await this.loadTokenizer(modelConfig);

      logger.info("Tokenizer loaded, encoding text...");
      const encoded = await tokenizer.encode(text, {
        add_special_tokens: true,
        return_token_type_ids: false,
      });

      logger.info(
        {
          tokenCount: encoded.length,
          tokenizer: modelConfig.tokenizer.name,
        },
        "Text encoded successfully"
      );
      return encoded;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          textLength: text.length,
          tokenizer: modelConfig.tokenizer.name,
          modelsDir: this.modelsDir,
        },
        "Text encoding failed"
      );
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
      logger.info(
        {
          count: tokens.length,
          tokenizer: modelConfig.tokenizer.name,
        },
        "Decoding tokens with tokenizer"
      );

      const tokenizer = await this.loadTokenizer(modelConfig);

      logger.info("Tokenizer loaded, decoding tokens...");
      const decoded = await tokenizer.decode(tokens, {
        skip_special_tokens: true,
        clean_up_tokenization_spaces: true,
      });

      logger.info(
        {
          textLength: decoded.length,
          tokenizer: modelConfig.tokenizer.name,
        },
        "Tokens decoded successfully"
      );
      return decoded;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          tokenCount: tokens.length,
          tokenizer: modelConfig.tokenizer.name,
          modelsDir: this.modelsDir,
        },
        "Token decoding failed"
      );
      throw error;
    }
  }
}
