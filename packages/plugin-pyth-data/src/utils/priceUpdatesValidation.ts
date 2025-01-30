import { elizaLogger } from "@elizaos/core";
import { DataError, PythErrorCode, ErrorSeverity } from "../error";
import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({
    allErrors: true,
    verbose: true,
    coerceTypes: true,
    useDefaults: true
});

// Price updates schema
export const priceUpdatesSchema = {
    type: 'object',
    required: ['priceIds'],
    properties: {
        text: { type: 'string' },
        priceIds: {
            type: 'array',
            items: {
                type: 'string',
                pattern: '^(0x)?[0-9a-fA-F]+$'
            },
            minItems: 1,
            description: 'Array of price feed IDs to fetch updates for'
        },
        options: {
            type: 'object',
            properties: {
                encoding: {
                    type: 'string',
                    enum: ['hex', 'base64'],
                    description: 'Encoding format for the price updates'
                },
                parsed: {
                    type: 'boolean',
                    description: 'Whether to return parsed price updates'
                }
            }
        }
    }
};

/**
 * Validates price updates data against the schema
 * @param data Data to validate
 * @returns Promise<boolean> True if validation succeeds
 * @throws DataError if validation fails
 */
export async function validatePriceUpdatesData(data: unknown): Promise<boolean> {
    try {
        const validate = ajv.compile(priceUpdatesSchema);
        const valid = validate(data);

        if (!valid) {
            const errors = validate.errors || [];
            elizaLogger.error("Price updates validation failed", {
                errors,
                data
            });

            throw new DataError(
                PythErrorCode.DATA_VALIDATION_FAILED,
                "Price updates validation failed",
                ErrorSeverity.HIGH,
                {
                    errors: errors.map((err: ErrorObject) => ({
                        path: err.schemaPath,
                        message: err.message,
                        params: err.params
                    })),
                    data
                }
            );
        }

        return true;
    } catch (error) {
        if (error instanceof DataError) {
            throw error;
        }

        elizaLogger.error("Price updates validation error", {
            error: error instanceof Error ? error.message : String(error),
            data
        });

        throw new DataError(
            PythErrorCode.DATA_SCHEMA_ERROR,
            "Price updates validation error",
            ErrorSeverity.HIGH,
            {
                error: error instanceof Error ? error.message : String(error),
                data
            }
        );
    }
}

/**
 * Validates a price ID format
 * @param priceId Price ID to validate
 * @returns boolean True if price ID is valid
 */
export function validatePriceId(priceId: string): boolean {
    return /^(0x)?[0-9a-fA-F]+$/.test(priceId);
}