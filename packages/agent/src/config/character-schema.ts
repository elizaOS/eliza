import { z } from "zod";

const MessageExampleContentSchema = z
  .object({
    text: z.string().min(1),
    actions: z.array(z.string()).optional(),
  })
  .strict();

const MessageExampleSchema = z
  .object({
    name: z.string().min(1),
    content: MessageExampleContentSchema,
  })
  .strict();

const MessageExampleGroupSchema = z
  .object({
    examples: z.array(MessageExampleSchema).min(1),
  })
  .strict();

const CharacterStyleSchema = z
  .object({
    all: z.array(z.string()).optional(),
    chat: z.array(z.string()).optional(),
    post: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const CharacterSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    username: z.string().max(50).optional(),
    bio: z.union([z.string(), z.array(z.string())]).optional(),
    system: z.string().max(10000).optional(),
    adjectives: z.array(z.string().min(1).max(100)).optional(),
    topics: z.array(z.string().min(1).max(100)).optional(),
    style: CharacterStyleSchema,
    messageExamples: z.array(MessageExampleGroupSchema).optional(),
    postExamples: z.array(z.string()).optional(),
  })
  .strict();
