/**
 * Database Setup Prompt
 *
 * Instructions for the AI to set up Drizzle ORM when a database is available.
 * DATABASE_URL is automatically injected for drizzle-kit commands.
 */

export const DATABASE_SETUP_PROMPT = `## Database Setup

A PostgreSQL database has been provisioned for this app. Use Drizzle ORM to interact with it.

**DATABASE_URL is automatically available** when you run drizzle-kit commands via run_command.

### Required Setup Steps

1. **Install dependencies**:
\`\`\`bash
run_command("npm install drizzle-orm @neondatabase/serverless && npm install -D drizzle-kit")
\`\`\`

2. **Create \`drizzle.config.ts\`** in the project root:
\`\`\`typescript
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
\`\`\`

3. **Create \`db/schema.ts\`** with your table definitions:
\`\`\`typescript
import { pgTable, text, timestamp, uuid, boolean, integer } from 'drizzle-orm/pg-core';

// Define tables based on the app requirements
export const items = pgTable('items', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  completed: boolean('completed').default(false),
  // IMPORTANT: Always use { withTimezone: true } for timestamps to avoid timezone issues
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()),
});
\`\`\`

**Critical: Drizzle timestamps and dates**
- **Always** use \`{ withTimezone: true }\` - Without it, timestamps have timezone confusion between JS and PostgreSQL
- Use \`$onUpdate(() => new Date())\` on updatedAt columns - This auto-updates on any row change
- If you need string dates instead of Date objects, use \`{ mode: 'string', withTimezone: true }\`

4. **Create \`db/index.ts\`** for the database client:
\`\`\`typescript
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });
\`\`\`

5. **Push schema to database** using run_command:
\`\`\`bash
run_command("npx drizzle-kit push --force")
\`\`\`

### Available drizzle-kit Commands

All these commands automatically have DATABASE_URL injected:

- \`npx drizzle-kit push --force\` - Push schema changes to database (recommended for development)
- \`npx drizzle-kit generate\` - Generate migration files
- \`npx drizzle-kit migrate\` - Apply pending migrations
- \`npx drizzle-kit pull\` - Pull schema from existing database
- \`npx drizzle-kit check\` - Check for schema drift
- \`npx drizzle-kit studio\` - Open Drizzle Studio (database browser)

### Important Rules

- **Use run_command for drizzle-kit** - DATABASE_URL is injected automatically
- **Use Server Actions or API routes** for ALL runtime database operations
- **Put all database files in the \`db/\` directory**
- **Run drizzle-kit push after ANY schema changes**
- **Always handle errors** in database operations

### API route example (Hono / fetch handler)

\`\`\`typescript
// server: return JSON from your Hono route or API handler
import { db } from '@/db';
import { items } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function getItems() {
  return db.select().from(items).orderBy(items.createdAt);
}

export async function createItem(name: string, description?: string) {
  const result = await db.insert(items).values({ name, description }).returning();
  return result[0];
}

export async function updateItem(id: string, data: { name?: string; completed?: boolean }) {
  // Note: updatedAt auto-updates via $onUpdate in schema - no need to set it manually
  const result = await db.update(items)
    .set(data)
    .where(eq(items.id, id))
    .returning();
  return result[0];
}

export async function deleteItem(id: string) {
  await db.delete(items).where(eq(items.id, id));
}
\`\`\`

### Using in Components (React client)

\`\`\`typescript
// e.g. useQuery + mutation invalidation against your Hono API
import { useQuery } from '@tanstack/react-query';

export function ItemList() {
  const { data: items = [] } = useQuery({ queryKey: ['items'], queryFn: () => fetch('/api/items').then(r => r.json()) });
  return (
    <div>
      {items.map((item: { id: string; name: string }) => (
        <div key={item.id}>{item.name}</div>
      ))}
    </div>
  );
}
\`\`\`
`;

/**
 * Additional rules for database usage security.
 */
export const DATABASE_SECURITY_RULES = `### Database Security Rules

1. **Server-side only**: All database operations MUST happen in:
   - Server Actions (files with 'use server')
   - API Routes (app/api/*)
   - Server Components (default in App Router)

2. **Never do this**:
   - Don't import db in client components
   - Don't pass DATABASE_URL to client code
   - Don't use db in 'use client' files
   - Don't log or echo connection strings
   - Don't write DATABASE_URL to any file

3. **drizzle-kit is special**: DATABASE_URL is automatically injected when you run drizzle-kit commands via run_command. You don't need to set it manually.

4. **Input validation**: Always validate user input before database operations:
\`\`\`typescript
import { z } from 'zod';

const ItemSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export async function createItem(input: unknown) {
  const parsed = ItemSchema.parse(input);
  // Now safe to use parsed.name, parsed.description
}
\`\`\`
`;
