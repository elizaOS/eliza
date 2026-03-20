# Eliza Cloud V2

## Stack
- **Runtime**: Bun
- **Framework**: Next.js 15 (App Router)
- **Database**: PostgreSQL + Drizzle ORM
- **Deployment**: Vercel Serverless
- **UI**: React + Tailwind CSS

## Commands
```bash
bun install          # Install dependencies
bun run dev          # Start dev server
bun run build        # Production build
bun run db:migrate   # Apply database migrations
bun run db:generate  # Generate migration from schema
bun run db:studio    # Open Drizzle Studio
```

## Database Migrations

**Never use `db:push` - it's removed. All schema changes go through migrations.**

### Schema Change Workflow
1. Edit schema in `db/schemas/`
2. `bun run db:generate`
3. Review SQL in `db/migrations/`
4. `bun run db:migrate`
5. Commit both schema + migration

### Custom Migrations
```bash
npx drizzle-kit generate --custom --name=descriptive_name
```

### Rules
- No `CREATE INDEX CONCURRENTLY` (runs in transaction)
- Use `IF NOT EXISTS` / `IF EXISTS`
- Never edit applied migrations
- See `docs/database-migrations.md` for details

## Project Structure
```
app/           # Next.js App Router pages
lib/           # Business logic, services
db/
  schemas/     # Drizzle schema definitions
  migrations/  # SQL migration files
  repositories/# Data access layer
components/    # React components
scripts/       # CLI utilities
```

## Code Quality Guidelines

### Security
- No hardcoded API keys, secrets, or credentials - use environment variables
- Sanitize user inputs to prevent SQL injection and XSS
- Review dependencies for known vulnerabilities

### TypeScript
- Avoid using `any` type - use proper type definitions
- Define interfaces for all data structures
- Enable strict mode in tsconfig.json

### Testing
- Use Vitest for unit and integration tests
- Write tests for new features and bug fixes
- Run `bun test` before committing
