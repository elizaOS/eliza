import { elizaLogger } from "@elizaos/core";
import { DataError, PythErrorCode, ErrorSeverity } from "../error";
import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({
    allErrors: true,
    verbose: true,
    coerceTypes: true,
    useDefaults: true
});

// Publisher caps schema
export const publisherCapsSchema = {
    type: 'object',
    properties: {
        text: { type: 'string' },
        success: { type: 'boolean' },
        data: {
            type: 'object',
            properties: {
                caps: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['publisher', 'cap', 'timestamp'],
                        properties: {
                            publisher: {
                                type: 'string',
                                pattern: '^0x[a-fA-F0-9]{40}$'  // Ethereum address format
                            },
                            cap: {
                                type: 'number',
                                minimum: 0
                            },
                            timestamp: {
                                type: 'number',
                                minimum: 0
                            }
                        }
                    }
                },
                error: { type: 'string' }
            }
        }
    }
};

/**
 * Validates publisher caps data against the schema
 * @param data Data to validate
 * @returns Promise<boolean> True if validation succeeds
 * @throws DataError if validation fails
 */
export async function validatePublisherCapsData(data: unknown): Promise<boolean> {
    try {
        const validate = ajv.compile(publisherCapsSchema);
        const valid = validate(data);

        if (!valid) {
            const errors = validate.errors || [];
            elizaLogger.error("Publisher caps validation failed", {
                errors,
                data
            });

            throw new DataError(
                PythErrorCode.DATA_VALIDATION_FAILED,
                "Publisher caps validation failed",
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

        elizaLogger.error("Publisher caps validation error", {
            error: error instanceof Error ? error.message : String(error),
            data
        });

        throw new DataError(
            PythErrorCode.DATA_SCHEMA_ERROR,
            "Publisher caps validation error",
            ErrorSeverity.HIGH,
            {
                error: error instanceof Error ? error.message : String(error),
                data
            }
        );
    }
}

/**
 * Validates a publisher address format
 * @param publisher Publisher address to validate
 * @returns boolean True if address is valid
 */
export function validatePublisherAddress(publisher: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(publisher);
}

/**
 * Validates a cap value
 * @param cap Cap value to validate
 * @returns boolean True if cap is valid
 */
export function validateCap(cap: number): boolean {
    return !isNaN(cap) && cap >= 0;
}