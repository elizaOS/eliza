import { z } from 'zod';
import type { Character } from '../types/agent';
import { ChannelType } from '../types/environment';
import { ContentType } from '../types/primitives';
export declare const uuidSchema: z.ZodString;
export declare const mediaSchema: z.ZodObject<{
    id: z.ZodString;
    url: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    text: z.ZodOptional<z.ZodString>;
    contentType: z.ZodOptional<z.ZodEnum<typeof ContentType>>;
}, z.core.$loose>;
export declare const contentSchema: z.ZodObject<{
    text: z.ZodOptional<z.ZodString>;
    thought: z.ZodOptional<z.ZodString>;
    actions: z.ZodOptional<z.ZodArray<z.ZodString>>;
    providers: z.ZodOptional<z.ZodArray<z.ZodString>>;
    source: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodString>;
    url: z.ZodOptional<z.ZodString>;
    inReplyTo: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        url: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        text: z.ZodOptional<z.ZodString>;
        contentType: z.ZodOptional<z.ZodEnum<typeof ContentType>>;
    }, z.core.$loose>>>;
    channelType: z.ZodOptional<z.ZodEnum<typeof ChannelType>>;
}, z.core.$catchall<z.ZodUnknown>>;
export declare const messageExampleSchema: z.ZodObject<{
    name: z.ZodString;
    content: z.ZodObject<{
        text: z.ZodOptional<z.ZodString>;
        thought: z.ZodOptional<z.ZodString>;
        actions: z.ZodOptional<z.ZodArray<z.ZodString>>;
        providers: z.ZodOptional<z.ZodArray<z.ZodString>>;
        source: z.ZodOptional<z.ZodString>;
        target: z.ZodOptional<z.ZodString>;
        url: z.ZodOptional<z.ZodString>;
        inReplyTo: z.ZodOptional<z.ZodString>;
        attachments: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            url: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            text: z.ZodOptional<z.ZodString>;
            contentType: z.ZodOptional<z.ZodEnum<typeof ContentType>>;
        }, z.core.$loose>>>;
        channelType: z.ZodOptional<z.ZodEnum<typeof ChannelType>>;
    }, z.core.$catchall<z.ZodUnknown>>;
}, z.core.$strip>;
export declare const directoryItemSchema: z.ZodObject<{
    directory: z.ZodString;
    shared: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const knowledgeItemSchema: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
    path: z.ZodString;
    shared: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    directory: z.ZodString;
    shared: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>]>;
export declare const templateTypeSchema: z.ZodUnion<readonly [z.ZodString, z.ZodOptional<z.ZodFunction<z.core.$ZodFunctionArgs, z.core.$ZodFunctionOut>>]>;
export declare const styleSchema: z.ZodOptional<z.ZodObject<{
    all: z.ZodOptional<z.ZodArray<z.ZodString>>;
    chat: z.ZodOptional<z.ZodArray<z.ZodString>>;
    post: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>>;
export declare const settingsSchema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodNumber, z.ZodObject<{}, z.core.$loose>, z.ZodArray<z.ZodAny>]>>>;
export declare const secretsSchema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodNumber]>>>;
export declare const characterSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    username: z.ZodOptional<z.ZodString>;
    system: z.ZodOptional<z.ZodString>;
    templates: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodOptional<z.ZodFunction<z.core.$ZodFunctionArgs, z.core.$ZodFunctionOut>>]>>>;
    bio: z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>;
    messageExamples: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        content: z.ZodObject<{
            text: z.ZodOptional<z.ZodString>;
            thought: z.ZodOptional<z.ZodString>;
            actions: z.ZodOptional<z.ZodArray<z.ZodString>>;
            providers: z.ZodOptional<z.ZodArray<z.ZodString>>;
            source: z.ZodOptional<z.ZodString>;
            target: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodString>;
            inReplyTo: z.ZodOptional<z.ZodString>;
            attachments: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                url: z.ZodString;
                title: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                text: z.ZodOptional<z.ZodString>;
                contentType: z.ZodOptional<z.ZodEnum<typeof ContentType>>;
            }, z.core.$loose>>>;
            channelType: z.ZodOptional<z.ZodEnum<typeof ChannelType>>;
        }, z.core.$catchall<z.ZodUnknown>>;
    }, z.core.$strip>>>>;
    postExamples: z.ZodOptional<z.ZodArray<z.ZodString>>;
    topics: z.ZodOptional<z.ZodArray<z.ZodString>>;
    adjectives: z.ZodOptional<z.ZodArray<z.ZodString>>;
    knowledge: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        path: z.ZodString;
        shared: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodObject<{
        directory: z.ZodString;
        shared: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>]>>>;
    plugins: z.ZodOptional<z.ZodArray<z.ZodString>>;
    settings: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodNumber, z.ZodObject<{}, z.core.$loose>, z.ZodArray<z.ZodAny>]>>>;
    secrets: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodNumber]>>>;
    style: z.ZodOptional<z.ZodObject<{
        all: z.ZodOptional<z.ZodArray<z.ZodString>>;
        chat: z.ZodOptional<z.ZodArray<z.ZodString>>;
        post: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strict>;
export interface CharacterValidationResult {
    success: boolean;
    data?: Character;
    error?: {
        message: string;
        issues?: z.ZodIssue[];
    };
}
/**
 * Safely validates character data using Zod schema
 * @param data - Raw character data to validate
 * @returns Validation result with success flag and either data or error
 */
export declare function validateCharacter(data: unknown): CharacterValidationResult;
/**
 * Safely parses JSON string and validates as character
 * @param jsonString - JSON string to parse and validate
 * @returns Validation result with success flag and either data or error
 */
export declare function parseAndValidateCharacter(jsonString: string): CharacterValidationResult;
/**
 * Type guard to check if data is a valid Character
 * @param data - Data to check
 * @returns True if data is a valid Character
 */
export declare function isValidCharacter(data: unknown): data is Character;
//# sourceMappingURL=character.d.ts.map